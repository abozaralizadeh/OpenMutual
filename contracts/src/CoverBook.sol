// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MutualPool} from "./MutualPool.sol";
import {ResultOracle} from "./ResultOracle.sol";

interface IClaimReview {
    function open(uint256 coverId, address holder, bytes32 evidenceHash) external returns (uint256);
}

/// @notice Sells covers and ends them. Each cover is one promise: pay `payout`
/// to the holder if the event's rule is met.
///
/// Automatic products settle from ResultOracle. Nobody files anything.
/// Reviewed products settle from a vote by members in ClaimReview.
contract CoverBook is EIP712, Ownable {
    using SafeERC20 for IERC20;

    enum Kind {
        Automatic,
        Reviewed
    }

    enum Status {
        None,
        Active,
        ClaimOpen,
        PaidOut,
        Expired,
        Refunded
    }

    enum ClaimOutcome {
        Approved,
        Rejected,
        NoQuorum
    }

    struct Product {
        bool active;
        Kind kind;
        uint32 trigger;
        uint32 salesCutoff;
        uint32 resultDeadline;
        uint16 eventLimitBps;
        uint128 maxPayout;
    }

    struct Cover {
        address holder;
        uint32 productId;
        uint40 eventTime;
        Status status;
        uint128 premium;
        uint128 payout;
        bytes32 eventKey;
    }

    struct Quote {
        uint32 productId;
        bytes32 ref;
        uint40 eventTime;
        uint128 premium;
        uint128 payout;
        address buyer;
        uint40 expiresAt;
        bytes32 nonce;
    }

    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint32 productId,bytes32 ref,uint40 eventTime,uint128 premium,uint128 payout,address buyer,uint40 expiresAt,bytes32 nonce)"
    );

    IERC20 public immutable asset;
    MutualPool public immutable pool;
    ResultOracle public immutable oracle;

    address public quoter;
    address public claimReview;
    uint32 public productCount;
    uint256 public coverCount;

    mapping(uint32 => Product) public products;
    mapping(uint256 => Cover) public covers;
    mapping(bytes32 => uint256) public eventExposure;
    mapping(bytes32 => bool) public usedNonces;

    event ProductSet(uint32 indexed productId, Kind kind, bool active, uint32 trigger, uint32 salesCutoff, uint32 resultDeadline, uint16 eventLimitBps, uint128 maxPayout);
    event QuoterSet(address quoter);
    event ClaimReviewSet(address claimReview);
    event CoverSold(uint256 indexed coverId, address indexed holder, uint32 indexed productId, bytes32 eventKey, bytes32 ref, uint40 eventTime, uint128 premium, uint128 payout);
    event CoverEnded(uint256 indexed coverId, Status status, uint256 paidToHolder);
    event ClaimFiled(uint256 indexed coverId, uint256 indexed claimId, bytes32 evidenceHash);

    error Paused();
    error ProductNotActive();
    error QuoteExpired();
    error SalesClosed();
    error BadSignature();
    error QuoteAlreadyUsed();
    error NotTheBuyer();
    error BadAmounts();
    error OverEventLimit();
    error NotActive();
    error NotReady();
    error WrongKind();
    error NotHolder();
    error ClaimWindowClosed();
    error NotClaimReview();

    constructor(MutualPool pool_, ResultOracle oracle_, address owner_, address quoter_)
        EIP712("OpenMutual", "1")
        Ownable(owner_)
    {
        pool = pool_;
        oracle = oracle_;
        asset = IERC20(pool_.asset());
        quoter = quoter_;
    }

    // Settings

    function addProduct(Product calldata product) external onlyOwner returns (uint32 productId) {
        productId = ++productCount;
        _setProduct(productId, product);
    }

    function setProduct(uint32 productId, Product calldata product) external onlyOwner {
        if (productId == 0 || productId > productCount) revert ProductNotActive();
        _setProduct(productId, product);
    }

    function _setProduct(uint32 productId, Product calldata product) private {
        products[productId] = product;
        emit ProductSet(productId, product.kind, product.active, product.trigger, product.salesCutoff, product.resultDeadline, product.eventLimitBps, product.maxPayout);
    }

    function setQuoter(address quoter_) external onlyOwner {
        quoter = quoter_;
        emit QuoterSet(quoter_);
    }

    function setClaimReview(address claimReview_) external onlyOwner {
        claimReview = claimReview_;
        emit ClaimReviewSet(claimReview_);
    }

    // Reading

    function eventKeyOf(uint32 productId, bytes32 ref, uint40 eventTime) public pure returns (bytes32) {
        return keccak256(abi.encode(productId, ref, eventTime));
    }

    function eventLimit(uint32 productId) public view returns (uint256) {
        return pool.totalAssets() * products[productId].eventLimitBps / 10_000;
    }

    function quoteDigest(Quote calldata quote) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(QUOTE_TYPEHASH, quote)));
    }

    // Buying

    function buy(Quote calldata quote, bytes calldata signature) external returns (uint256 coverId) {
        Product memory product = products[quote.productId];
        if (pool.paused()) revert Paused();
        if (!product.active) revert ProductNotActive();
        if (msg.sender != quote.buyer) revert NotTheBuyer();
        if (block.timestamp > quote.expiresAt) revert QuoteExpired();
        if (block.timestamp + product.salesCutoff > quote.eventTime) revert SalesClosed();
        if (usedNonces[quote.nonce]) revert QuoteAlreadyUsed();
        if (ECDSA.recover(quoteDigest(quote), signature) != quoter) revert BadSignature();
        if (quote.premium == 0 || quote.premium >= quote.payout || quote.payout > product.maxPayout) revert BadAmounts();

        bytes32 key = eventKeyOf(quote.productId, quote.ref, quote.eventTime);
        uint256 exposure = eventExposure[key] + quote.payout;
        if (exposure > eventLimit(quote.productId)) revert OverEventLimit();

        usedNonces[quote.nonce] = true;
        eventExposure[key] = exposure;
        coverId = ++coverCount;
        covers[coverId] = Cover(msg.sender, quote.productId, quote.eventTime, Status.Active, quote.premium, quote.payout, key);

        if (product.kind == Kind.Automatic) {
            oracle.register(key, product.trigger, quote.eventTime - product.salesCutoff, quote.eventTime);
        }
        asset.safeTransferFrom(msg.sender, address(pool), quote.premium);
        pool.lockForCover(quote.premium, quote.payout);
        emit CoverSold(coverId, msg.sender, quote.productId, key, quote.ref, quote.eventTime, quote.premium, quote.payout);
    }

    // Ending

    /// @notice True when `settle` would end this cover now.
    function canSettle(uint256 coverId) public view returns (bool) {
        Cover storage cover = covers[coverId];
        if (cover.status != Status.Active) return false;
        Product storage product = products[cover.productId];
        if (product.kind == Kind.Automatic) return oracle.state(cover.eventKey) == ResultOracle.State.Final;
        return block.timestamp > uint256(cover.eventTime) + product.resultDeadline;
    }

    /// @notice True when the result never came and the premium can go back.
    function canRefund(uint256 coverId) public view returns (bool) {
        Cover storage cover = covers[coverId];
        if (cover.status != Status.Active) return false;
        Product storage product = products[cover.productId];
        if (product.kind != Kind.Automatic) return false;
        return block.timestamp > uint256(cover.eventTime) + product.resultDeadline
            && oracle.state(cover.eventKey) == ResultOracle.State.Waiting;
    }

    /// @notice Ends a cover. Anyone can call it, the rule decides the outcome.
    function settle(uint256 coverId) public {
        if (!canSettle(coverId)) revert NotReady();
        Cover storage cover = covers[coverId];
        bool paysOut = products[cover.productId].kind == Kind.Automatic && oracle.triggered(cover.eventKey);
        _end(coverId, paysOut ? MutualPool.CoverEnd.PaidOut : MutualPool.CoverEnd.Expired);
    }

    /// @notice Settles what's ready and skips the rest, so one cover can't block a batch.
    function settleMany(uint256[] calldata coverIds) external returns (uint256 settled) {
        for (uint256 i; i < coverIds.length; i++) {
            if (canSettle(coverIds[i])) {
                settle(coverIds[i]);
                settled++;
            }
        }
    }

    /// @notice Gives the premium back if no result arrived in time. Anyone can call it.
    function refund(uint256 coverId) external {
        if (!canRefund(coverId)) revert NotReady();
        _end(coverId, MutualPool.CoverEnd.Refunded);
    }

    // Claims that need a decision

    function fileClaim(uint256 coverId, bytes32 evidenceHash) external returns (uint256 claimId) {
        Cover storage cover = covers[coverId];
        if (cover.status != Status.Active) revert NotActive();
        if (msg.sender != cover.holder) revert NotHolder();
        Product storage product = products[cover.productId];
        if (product.kind != Kind.Reviewed) revert WrongKind();
        if (block.timestamp > uint256(cover.eventTime) + product.resultDeadline) revert ClaimWindowClosed();

        cover.status = Status.ClaimOpen;
        claimId = IClaimReview(claimReview).open(coverId, msg.sender, evidenceHash);
        emit ClaimFiled(coverId, claimId, evidenceHash);
    }

    function resolveClaim(uint256 coverId, ClaimOutcome outcome) external {
        if (msg.sender != claimReview) revert NotClaimReview();
        if (covers[coverId].status != Status.ClaimOpen) revert NotActive();
        if (outcome == ClaimOutcome.Approved) _end(coverId, MutualPool.CoverEnd.PaidOut);
        else if (outcome == ClaimOutcome.Rejected) _end(coverId, MutualPool.CoverEnd.Expired);
        else _end(coverId, MutualPool.CoverEnd.Refunded);
    }

    function _end(uint256 coverId, MutualPool.CoverEnd end) private {
        Cover storage cover = covers[coverId];
        Status status = end == MutualPool.CoverEnd.PaidOut
            ? Status.PaidOut
            : end == MutualPool.CoverEnd.Expired ? Status.Expired : Status.Refunded;
        cover.status = status;
        uint256 paid = pool.releaseCover(cover.holder, cover.premium, cover.payout, end);
        emit CoverEnded(coverId, status, paid);
    }
}
