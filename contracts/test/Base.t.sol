// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {MutualPool} from "../src/MutualPool.sol";
import {ResultOracle} from "../src/ResultOracle.sol";
import {CoverBook} from "../src/CoverBook.sol";
import {Membership} from "../src/Membership.sol";
import {ClaimReview} from "../src/ClaimReview.sol";

abstract contract Base is Test {
    uint256 internal constant ONE = 1e6;
    uint256 internal constant POOL_CAP = 10_000_000 * ONE;
    uint256 internal constant WAIT = 7 days;
    uint32 internal constant FLIGHT = 1;
    uint32 internal constant BAG = 2;
    uint32 internal constant TRIGGER = 180;
    uint32 internal constant CUTOFF = 1 days;
    uint32 internal constant DEADLINE = 7 days;
    uint32 internal constant CHALLENGE = 1 hours;

    TestUSD internal usd;
    MutualPool internal pool;
    ResultOracle internal oracle;
    CoverBook internal book;
    Membership internal members;
    ClaimReview internal review;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal verifier = makeAddr("verifier");
    address internal backer = makeAddr("backer");
    address internal backer2 = makeAddr("backer2");
    address internal member = makeAddr("member");
    address internal reporter1 = makeAddr("reporter1");
    address internal reporter2 = makeAddr("reporter2");
    address internal reporter3 = makeAddr("reporter3");
    uint256 internal quoterKey = 0xA11CE;
    address internal quoter = vm.addr(quoterKey);
    uint256 private nonce;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usd = new TestUSD();
        pool = new MutualPool(usd, admin, guardian, POOL_CAP, WAIT, 0);
        oracle = new ResultOracle(admin, guardian, 2, CHALLENGE);
        book = new CoverBook(pool, oracle, admin, quoter);
        members = new Membership(admin, verifier);
        review = new ClaimReview(book, members, 3 days, 1_000, 3);

        vm.startPrank(admin);
        pool.setCoverBook(address(book));
        oracle.setRegistrar(address(book));
        oracle.setReporter(reporter1, true);
        oracle.setReporter(reporter2, true);
        oracle.setReporter(reporter3, true);
        book.setClaimReview(address(review));
        book.addProduct(CoverBook.Product(true, CoverBook.Kind.Automatic, TRIGGER, CUTOFF, DEADLINE, 1_000, uint128(1_000 * ONE)));
        book.addProduct(CoverBook.Product(true, CoverBook.Kind.Reviewed, 0, 0, DEADLINE, 1_000, uint128(1_000 * ONE)));
        vm.stopPrank();

        for (uint256 i; i < 40; i++) usd.faucet(backer);
        usd.faucet(backer2);
        usd.faucet(member);
        vm.prank(backer);
        usd.approve(address(pool), type(uint256).max);
        vm.prank(backer2);
        usd.approve(address(pool), type(uint256).max);
        vm.prank(member);
        usd.approve(address(book), type(uint256).max);
    }

    function deposit(address who, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return pool.deposit(amount, who);
    }

    function quote(uint32 productId, bytes32 ref, uint40 eventTime, uint128 premium, uint128 payout, address buyer)
        internal
        returns (CoverBook.Quote memory q, bytes memory signature)
    {
        q = CoverBook.Quote(productId, ref, eventTime, premium, payout, buyer, uint40(block.timestamp + 10 minutes), keccak256(abi.encode(++nonce)));
        signature = sign(q, quoterKey);
    }

    function sign(CoverBook.Quote memory q, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, book.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function buy(uint32 productId, bytes32 ref, uint40 eventTime, uint128 premium, uint128 payout, address buyer)
        internal
        returns (uint256 id)
    {
        (CoverBook.Quote memory q, bytes memory signature) = quote(productId, ref, eventTime, premium, payout, buyer);
        vm.prank(buyer);
        id = book.buy(q, signature);
    }

    function report(bytes32 key, uint32 value) internal {
        vm.prank(reporter1);
        oracle.report(key, value);
        vm.prank(reporter2);
        oracle.report(key, value);
    }

    function keyOf(uint256 coverId) internal view returns (bytes32 key) {
        (,,,,,, key) = book.covers(coverId);
    }

    function statusOf(uint256 coverId) internal view returns (CoverBook.Status status) {
        (,,, status,,,) = book.covers(coverId);
    }
}
