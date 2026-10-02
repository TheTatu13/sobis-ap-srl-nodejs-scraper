/**
 * SOBIS AP Job Scraper - Main Entry Point
 * 
 * PURPOSE: Scrapes job listings from SOBIS AP careers page and stores them in Solr.
 * This is the primary orchestrator that coordinates company validation, job scraping,
 * data transformation, and Solr storage.
 */

import { fetchWithRetry as fetch, assertCanary } from "./src/premium.js";
import * as cheerio from "cheerio";
import fs from "fs";
import { fileURLToPath } from "url";
import { validateAndGetCompany } from "./company.js";
import { querySOLR, deleteJobByUrl, upsertJobs, upsertCompany } from "./solr.js";
import { generateJobsMarkdown } from "./src/markdown-generator.js";
import companyConfig from "./config/company.js";

// ============================================================================
// CONFIGURATION CONSTANTS — derived from config/company.json
// ============================================================================

const COMPANY_CIF = companyConfig.cif;
const CAREER_URL = companyConfig.careerUrl;

// Request timeout in milliseconds (10 seconds, per INSTRUCTIONS.md)
const TIMEOUT = 10000;

// Global variable to store company name after validation
let COMPANY_NAME = null;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Promise-based sleep function to introduce delays between requests
 * @param {number} ms - Milliseconds to sleep
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Searches ANOFM (Agentia Nationala pentru Ocuparea Fortei de Munca) for
 * job listings belonging to the given company CIF. Uses the public ANOFM API.
 * @param {string} cif - Company CIF
 * @returns {Promise<Array>} - Array of job objects { url, title, location, source }
 */
async function searchANOFM(cif) {
  const jobs = [];
  try {
    console.log(`Searching ANOFM by CIF: ${cif}`);
    const payload = {
      current: 1,
      rowCount: 250,
      sort: { created_at: "desc" },
      employer_tax_code: cif
    };
    const res = await fetch("https://mediere.anofm.ro/api/entity/vw_public_job_posting", {
      method: "POST",
      timeout: TIMEOUT,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "job_seeker_ro_spider"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.log(`  ANOFM returned ${res.status}`);
      return jobs;
    }
    const data = await res.json();
    for (const row of data.rows || []) {
      const locationParts = (row.address_locality_name || '').split('>').map(s => s.trim());
      const location = locationParts.length > 1 ? locationParts[locationParts.length - 1] : locationParts[0];
      jobs.push({
        url: `https://mediere.anofm.ro/app/module/mediere/job/${row.id}`,
        title: row.occupation,
        location: location ? [location] : undefined,
        source: "ANOFM"
      });
    }
    console.log(`  Found ${jobs.length} jobs on ANOFM`);
  } catch (err) {
    console.log(`  ANOFM error: ${err.message}`);
  }
  return jobs;
}

// ============================================================================
// API FUNCTIONS - Fetching data from SOBIS AP careers page
// ============================================================================

/**
 * Fetches the SOBIS AP careers page HTML
 * @returns {Promise<string>} - Raw HTML content
 */
async function fetchCareersPage() {
  const res = await fetch(CAREER_URL, {
    headers: {
      "User-Agent": "job_seeker_ro_spider",
      "Accept": "text/html"
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP error ${res.status} for careers page`);
  }

  return await res.text();
}

// ============================================================================
// DATA PARSING - Converting HTML response to our job model
// ============================================================================

/**
 * Parses raw HTML response into our standardized job format
 * @param {string} html - Raw HTML from SOBIS AP careers page
 * @returns {Object} - Object containing jobs array and total count
 */
function parseCareersHtml(html) {
  const $ = cheerio.load(html);
  const jobs = [];

  // SOBIS AP uses a tabbed interface with button.job-tab and article.job-panel
  // Each tab button has: .careers-job-tab-topline, strong (title), .careers-job-tab-department, .careers-job-tab-vacancies
  // Each panel has: header with h2, .careers-job-meta with location/workmode/level/positions/deadline

  $("article.careers-job-panel").each((i, panel) => {
    const $panel = $(panel);
    const panelId = $panel.attr("id") || "";
    const slug = panelId.replace("careers-panel-", "");

    // Extract title from h2
    const title = $panel.find("header h2").text().trim();
    if (!title) return;

    // Extract department
    const department = $panel.find(".careers-job-panel-label").text().trim();

    // Extract meta info
    const metaSpans = $panel.find(".careers-job-meta span");
    let location = [];
    let workmode = "on-site";
    let level = "";
    let positions = 1;
    let deadline = "";

    metaSpans.each((j, span) => {
      const text = $(span).text().trim();
      if (text.includes("Sibiu") || text.includes("România") || text.includes("București") || text.includes("Remote")) {
        // Location span
        const locMatch = text.match(/^(.*?)(?:\s*$)/);
        if (locMatch) {
          const loc = locMatch[1].replace(/\s+/g, " ").trim();
          if (loc) location = [loc];
        }
      }
      if (text.includes("Full-time") || text.includes("Part-time")) {
        // Contract type — skip
      }
      if (text.includes("On-site") || text.includes("on-site")) {
        workmode = "on-site";
      } else if (text.includes("Remote") || text.includes("remote")) {
        workmode = "remote";
      } else if (text.includes("Hibrid") || text.includes("hibrid") || text.includes("Hybrid")) {
        workmode = "hybrid";
      }
      if (text.includes("post")) {
        const posMatch = text.match(/(\d+)\s+post/);
        if (posMatch) positions = parseInt(posMatch[1]);
      }
      if (text.includes("Deadline:")) {
        deadline = text.replace("Deadline:", "").trim();
      }
    });

    // Extract level from meta (Junior / Middle / Senior pattern)
    metaSpans.each((j, span) => {
      const text = $(span).text().trim();
      if (text.match(/^(Junior|Middle|Senior|Minimum \d+)/i)) {
        level = text;
      }
    });

    // Build job URL — use the careers page with anchor to the panel
    const url = `${CAREER_URL}#${panelId}`;

    // Extract job description sections
    const sections = [];
    $panel.find(".careers-job-section").each((j, section) => {
      const heading = $(section).find("h3, strong").first().text().trim();
      const content = $(section).find("p, ul, ol").text().trim();
      if (heading || content) {
        sections.push({ heading, content });
      }
    });

    // Extract tags from description content (skills, technologies mentioned)
    const allText = $panel.text().toLowerCase();
    const tags = [];
    const knownTags = [
      "sql", "server", "c#", ".net", "dotnet", "javascript", "html", "css",
      "react", "angular", "vue", "node", "python", "java", "php",
      "wordpress", "wooocommerce", "mysql", "postgresql", "oracle", "mongodb",
      "docker", "kubernetes", "aws", "azure", "gcp", "linux", "windows",
      "git", "ci/cd", "agile", "scrum", "jira", "excel", "word", "powerpoint",
      "ai", "machine learning", "ml", "llm", "openai", "chatgpt",
      "asp.net", "blazor", "wpf", "winforms", "api", "rest", "graphql",
      "firebird", "access", "csv", "etl", "ssis", "ssrs", "reporting"
    ];
    for (const tag of knownTags) {
      if (allText.includes(tag)) {
        tags.push(tag);
      }
    }

    // Parse vacancies count from tab (more reliable)
    const tabId = `careers-tab-${slug}`;
    const $tab = $(`#${tabId}`);
    const vacanciesText = $tab.find(".careers-job-tab-vacancies").text().trim();
    const vacMatch = vacanciesText.match(/(\d+)/);
    const totalPositions = vacMatch ? parseInt(vacMatch[1]) : positions;

    // Create one job entry per position available
    for (let p = 0; p < totalPositions; p++) {
      jobs.push({
        url,
        title,
        uid: slug,
        workmode,
        location: location.length > 0 ? location : ["Sibiu"],
        tags: tags.length > 0 ? tags : undefined,
        department,
        level: level || undefined,
        deadline: deadline || undefined
      });
    }
  });

  return {
    jobs,
    total: jobs.length
  };
}

// ============================================================================
// SCRAPING LOGIC - Collect all jobs from SOBIS AP
// ============================================================================

/**
 * Scrapes all job listings from SOBIS AP careers page
 * @param {boolean} testOnlyOnePage - If true, limits to first 3 jobs (for testing)
 * @returns {Promise<Array>} - Array of unique job objects
 */
async function scrapeAllListings(testOnlyOnePage = false) {
  const allJobs = [];
  const seenUrls = new Set();

  console.log(`Fetching careers page: ${CAREER_URL}`);
  const html = await fetchCareersPage();
  const result = parseCareersHtml(html);
  const jobs = result.jobs;

  console.log(`Found ${jobs.length} total job entries (${result.total} positions)`);

  // Collect unique jobs (avoid duplicates)
  for (const job of jobs) {
    const key = `${job.url}|${job.title}`;
    if (!seenUrls.has(key)) {
      seenUrls.add(key);
      allJobs.push(job);
    }
  }

  // Test mode: limit to first 3 jobs
  if (testOnlyOnePage) {
    console.log("Test mode: limiting to first 3 jobs.");
    return allJobs.slice(0, 3);
  }

  console.log(`Total unique jobs collected: ${allJobs.length}`);
  return allJobs;
}

// ============================================================================
// DATA TRANSFORMATION - Preparing jobs for Solr storage
// ============================================================================

/**
 * Maps raw job data to Solr-compatible job model with timestamps and status
 * @param {Object} rawJob - Job object from scraper
 * @param {string} cif - Company identifier
 * @param {string} companyName - Company name
 * @returns {Object} - Job object ready for Solr storage
 */
function mapToJobModel(rawJob, cif, companyName = COMPANY_NAME) {
  const now = new Date().toISOString();

  const job = {
    url: rawJob.url,
    title: rawJob.title,
    company: companyName,
    cif: cif,
    location: rawJob.location?.length ? rawJob.location : undefined,
    tags: rawJob.tags?.length ? rawJob.tags : undefined,
    workmode: rawJob.workmode || undefined,
    date: now,
    status: "scraped"
  };

  // Remove undefined fields to keep payload clean
  Object.keys(job).forEach((k) => job[k] === undefined && delete job[k]);

  return job;
}

/**
 * Transforms jobs to match Solr schema and filters for Romanian locations
 * @param {Object} payload - Job payload with jobs array
 * @returns {Object} - Transformed payload ready for Solr
 */
function transformJobsForSOLR(payload) {
  // List of Romanian cities for location validation
  const romanianCities = [
    'Bucharest', 'București', 'Cluj-Napoca', 'Cluj Napoca',
    'Timișoara', 'Timisoara', 'Iași', 'Iasi', 'Brașov', 'Brasov',
    'Constanța', 'Constanta', 'Craiova', 'Bacău', 'Sibiu',
    'Târgu Mureș', 'Targu Mures', 'Oradea', 'Baia Mare', 'Satu Mare',
    'Ploiești', 'Ploiesti', 'Pitești', 'Pitesti', 'Arad', 'Galați', 'Galati',
    'Brăila', 'Braila', 'Drobeta-Turnu Severin', 'Râmnicu Vâlcea', 'Ramnicu Valcea',
    'Buzău', 'Buzau', 'Botoșani', 'Botosani', 'Zalău', 'Zalau', 'Hunedoara', 'Deva',
    'Suceava', 'Bistrița', 'Bistrita', 'Tulcea', 'Călărași', 'Calarasi',
    'Giurgiu', 'Alba Iulia', 'Slatina', 'Piatra Neamț', 'Piatra Neamt', 'Roman',
    'Dumbrăvița', 'Dumbravita', 'Voluntari', 'Popești-Leordeni', 'Popesti-Leordeni',
    'Chitila', 'Mogoșoaia', 'Mogosoaia', 'Otopeni'
  ];

  const citySet = new Set(romanianCities.map(c => c.toLowerCase()));

  const normalizeWorkmode = (wm) => {
    if (!wm) return undefined;
    const lower = wm.toLowerCase();
    if (lower.includes('remote')) return 'remote';
    if (lower.includes('office') || lower.includes('on-site') || lower.includes('site')) return 'on-site';
    return 'hybrid';
  };

  const transformed = {
    ...payload,
    company: payload.company?.toUpperCase(),
    jobs: payload.jobs.map(job => {
      const validLocations = (job.location || []).filter(loc => {
        const lower = loc.toLowerCase().trim();
        if (lower === 'romania' || lower === 'românia') return true;
        return citySet.has(lower);
      }).map(loc => loc.toLowerCase() === 'romania' ? 'România' : loc);

      return {
        ...job,
        location: validLocations.length > 0 ? validLocations : ['România'],
        workmode: normalizeWorkmode(job.workmode)
      };
    })
  };

  return transformed;
}

// ============================================================================
// MAIN ORCHESTRATION - Coordinates the entire scraping workflow
// ============================================================================

/**
 * Main function that orchestrates the complete scraping workflow:
 * 1. Check existing jobs in Solr
 * 2. Validate company via ANAF
 * 3. Scrape jobs from SOBIS AP careers page
 * 4. Transform data for Solr
 * 5. Upsert jobs to Solr
 * 6. Report summary
 */
async function main() {
  const testOnlyOnePage = process.argv.includes("--test");

  try {
    fs.mkdirSync("tmp", { recursive: true });

    // Step 1: Get count of existing jobs in Solr
    console.log("=== Step 1: Get existing jobs count ===");
    const existingResult = await querySOLR(COMPANY_CIF);
    const existingCount = existingResult.numFound;
    console.log(`Found ${existingCount} existing jobs in SOLR`);

    // Step 2: Validate company data via ANAF
    console.log("=== Step 2: Validate company via ANAF ===");
    const { status, company, cif, address } = await validateAndGetCompany();
    COMPANY_NAME = company;
    const localCif = cif;

    // If company is inactive, jobs were already deleted by company.js — STOP
    if (status === "inactive") {
      console.log("\n⛔ Company is INACTIVE in ANAF — scraper stopping (no jobs to scrape)");
      return;
    }

    // Upsert company to SOLR company core
    try {
      await upsertCompany({
        id: cif,
        company,
        group: companyConfig.group,
        brand: companyConfig.brand,
        status: "activ",
        location: address ? [address] : [companyConfig.defaultLocation],
        website: [companyConfig.website],
        career: [companyConfig.careerUrl],
        lastScraped: new Date().toISOString().split('T')[0],
        scraperFile: companyConfig.scraperFile
      });
    } catch (err) {
      console.log(`Note: Could not upsert company to SOLR core: ${err.message}`);
    }

    // Step 3: Scrape all jobs from SOBIS AP careers page
    const rawJobs = await scrapeAllListings(testOnlyOnePage);
    const scrapedCount = rawJobs.length;
    console.log(`📊 Jobs scraped from SOBIS AP careers page: ${scrapedCount}`);

    // Step 3b: Also scrape ANOFM jobs for this CIF
    if (!testOnlyOnePage) {
      const anofmJobs = await searchANOFM(localCif);
      const anofmCount = anofmJobs.length;
      for (const job of anofmJobs) {
        if (!rawJobs.find(j => j.url === job.url)) {
          rawJobs.push(job);
        }
      }
      console.log(`📊 Jobs added from ANOFM: ${anofmCount}`);
    }
    // Canary counts careers page + ANOFM together (Solr jobs mostly come from ANOFM)
    assertCanary({ scraped: rawJobs.length, existing: existingCount, source: "careers page + ANOFM" });

    // Step 4: Map raw jobs to Solr model
    const jobs = rawJobs.map(job => mapToJobModel(job, localCif));

    const payload = {
      source: "sobis-ap.ro",
      scrapedAt: new Date().toISOString(),
      company: COMPANY_NAME,
      cif: localCif,
      jobs
    };

    // Step 5: Transform jobs (filter locations, normalize values)
    console.log("Transforming jobs for SOLR...");
    const transformedPayload = transformJobsForSOLR(payload);
    const validCount = transformedPayload.jobs.filter(j => j.location).length;
    console.log(`📊 Jobs with valid Romanian locations: ${validCount}`);

    // Save transformed jobs to file
    fs.writeFileSync("tmp/jobs.json", JSON.stringify(transformedPayload, null, 2), "utf-8");
    console.log("Saved tmp/jobs.json");

    // Generate and save docs/jobs.md
    const companyData = {
      id: localCif,
      company: transformedPayload.company,
      brand: companyConfig.brand,
      status: "activ",
      location: address ? [address] : [companyConfig.defaultLocation],
      website: [companyConfig.website],
      career: [companyConfig.careerUrl],
      lastScraped: new Date().toISOString().split('T')[0]
    };
    const markdown = generateJobsMarkdown(companyData, transformedPayload.jobs);
    fs.mkdirSync("docs", { recursive: true });
    fs.writeFileSync("docs/jobs.md", markdown, "utf-8");
    console.log("Saved docs/jobs.md");

    // Publish company config for GitHub Pages
    fs.writeFileSync("docs/company.json", JSON.stringify(companyConfig, null, 2), "utf-8");
    console.log("Saved docs/company.json");

    // Step 6: Upsert all jobs to Solr
    console.log("\n=== Step 6: Upsert jobs to SOLR ===");
    await upsertJobs(transformedPayload.jobs);

    // Step 7: Verify final count in Solr
    const finalResult = await querySOLR(COMPANY_CIF);
    console.log(`\n📊 === SUMMARY ===`);
    console.log(`📊 Jobs existing in SOLR before scrape: ${existingCount}`);
    console.log(`📊 Jobs scraped from SOBIS AP website: ${scrapedCount}`);
    console.log(`📊 Jobs in SOLR after scrape: ${finalResult.numFound}`);
    console.log(`====================`);

    console.log("\n=== DONE ===");
    console.log("Scraper completed successfully!");

  } catch (err) {
    console.error("Scraper failed:", err);
    process.exit(1);
  }
}

// Export functions for testing
export { parseCareersHtml, mapToJobModel, transformJobsForSOLR };

// Run main function when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
