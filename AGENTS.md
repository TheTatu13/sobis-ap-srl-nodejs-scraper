# AGENTS.md — Rules for AI agents

## Project
SOBIS AP scraper for peviitor.ro (Node.js, ESM, Jest)

## 🌱 This Repo Is a Derived Scraper
This repo is derived from the [EPAM template](https://github.com/sebiboga/epam-systems-international-srl-nodejs-scraper).

**All company-specific identity lives in `config/company.json`** (CIF, brand, legalName, URLs). Read from `config/company.js` in Node code, or via `jq` in workflows.

The scraping logic in `index.js` parses the SOBIS AP careers HTML page at `https://sobis-ap.ro/cariere/`.

## Critical Rules

### 0. Background tasks — always pass `--repo` explicitly to `gh`

When polling a workflow run, always specify the repo explicitly:
```bash
gh run view <RUN_ID> --repo TheTatu13/sobis-ap-srl-nodejs-scraper --json status -q .status
```

### 1. Temporary Files
All temporary/scratch files MUST go in `tmp/` inside the project root.

### 2. Issues & GitHub
- **Orice modificare de cod trebuie să aibă un issue în GitHub Issues** (vezi [ISSUES.md](ISSUES.md))
- Excepții: typo-uri, whitespace, documentație minoră
- Create a GitHub issue before implementing any change
- Commit messages must reference the issue they close
- Never commit credentials (`.env.local`, `*.pem`, etc.)

### 3. Environment Variables
- `SOLR_AUTH` must be set in `.env.local` for SOLR tests (format: `user:password`)
- `.env.local` is loaded automatically at runtime via `dotenv`

### 4. Testing
```bash
# All tests
npm test

# Unit tests (no env vars needed)
npm run test:unit

# Integration tests (ANAF public API, SOLR conditional)
npm run test:integration

# E2E tests (real SOBIS AP page, SOLR conditional)
npm run test:e2e

# Consistency tests (GitHub repo config)
npm run test:consistency
```

### 5. ESM + Jest
- Use `jest.unstable_mockModule` (NOT `jest.mock`) for mocking ESM modules
- Run with `--experimental-vm-modules` flag

### 6. Verification
- După orice modificare, urmează [VERIFY.md](VERIFY.md) pas cu pas
- Toate workflow-urile din `.github/workflows/` trebuie să treacă înainte de merge

### 7. Module Structure
- `config/company.json` + `config/company.js` — single source of truth for company identity
- `src/anaf.js` — core ANAF library (imported by company.js)
- `src/markdown-generator.js` — generates `docs/jobs.md` after each scrape
- `src/job-validator.js` — shared validateByHead + validateByContent
- `company.js` — company validation (ANAF + Peviitor + SOLR)
- `solr.js` — SOLR operations
- `validate-jobs.js` — manual deep validator
- `index.js` — main scraper orchestrator (HTML parsing with cheerio)
