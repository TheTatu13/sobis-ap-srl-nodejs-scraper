# Contributing

Thank you for your interest in contributing!

## 🌱 This Repo Is a Derived Scraper

This scraper is derived from the [EPAM template](https://github.com/peviitor-scrapers/epam-systems-international-srl-nodejs-scraper) and targets **SOBIS AP S.R.L.** (CIF 52200796).

**All company-specific identity lives in `config/company.json`.**

## Development Setup

```bash
# Clone the repo
git clone https://github.com/peviitor-scrapers/sobis-ap-srl-nodejs-scraper.git

# Install dependencies
npm install

# Run tests
npm test
```

## Code Style

- Use ES6+ modules (`type: module` in `package.json`)
- Add tests for new features in the matching `tests/<level>/` folder
- Ensure all tests pass before submitting PR
- Update relevant `.md` files when adding new files
- Reference a GitHub issue in every commit (see [ISSUES.md](ISSUES.md))

## Reporting Issues

Open a [GitHub Issue](https://github.com/peviitor-scrapers/sobis-ap-srl-nodejs-scraper/issues) with:
- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node version, OS)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
