# Coding standards

Review reads this file. Each rule is a judgement call; typecheck, Biome and the tests cover the rest.

## Engineering

Follow KISS · YAGNI · SoC · DRY/SSOT · Fail Fast · POLA.

## Tests

A test exists only to buy, at the lowest maintenance cost, confidence that the extension is right when people really use it. The closer a test is to how the extension is used, the more confidence it gives; a good test is sensitive to behaviour changes and insensitive to structure changes. Weigh test layers, test doubles and coverage by this.
