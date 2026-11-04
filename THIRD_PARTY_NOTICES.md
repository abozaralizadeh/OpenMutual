# Third party notices

OpenMutual's own code is under the PolyForm Noncommercial License 1.0.0 (see [LICENSE](LICENSE)). It builds on the packages below. They're installed from npm when you run `npm install` and keep their own licenses. None of their source is copied into this repo.

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| @openzeppelin/contracts | 5.6.1 | MIT | Building blocks for the contracts. Compiled contracts include parts of it |
| forge-std | 1.9.7 | MIT or Apache 2.0 | Contract tests |
| @foundry-rs/forge | 1.7.1 | MIT or Apache 2.0 | Building and testing the contracts |
| @foundry-rs/anvil | 1.7.1 | MIT or Apache 2.0 | The local test chain |
| viem | 2.57.14 | MIT | Talking to the chain |
| next | 16.4.3 | MIT | The web app |
| react, react-dom | 19.3.1 | MIT | The web app |
| tsx | 4.23.15 | MIT | Running TypeScript in the worker |
| vitest | 3.2.7 | MIT | Unit and flow tests |
| @playwright/test | 1.64.1 | Apache 2.0 | Browser tests |
| typescript | 5.9.3 | Apache 2.0 | Type checking |
| @types/node, @types/react, @types/react-dom | | MIT | Type definitions |

The packages these depend on are listed in `package-lock.json`, each with its own license.

The screenshots and the demo video show only this app. The app and the site use the fonts already on your device, so no font files are included.
