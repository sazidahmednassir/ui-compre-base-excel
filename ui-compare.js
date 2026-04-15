const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

// ─── Config ────────────────────────────────────────────────────────────────
const CSV_FILE = path.join(__dirname, "Url_compare_Sheet1.csv");
const OUTPUT_FILE = path.join(__dirname, "ui-compare-results.xlsx");
const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

// Similarity threshold (0–1). Pages scoring >= this are considered a match.
const MATCH_THRESHOLD = 0.85;

// Viewport used for both screenshots
const VIEWPORT = { width: 1280, height: 900 };

// ─── Helpers ────────────────────────────────────────────────────────────────
function parseCSV(filePath) {
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);

  const headers = lines[0].split(",").map((h) => h.trim());
  const localIdx = headers.findIndex((h) => h.toLowerCase() === "local");
  const prodIdx = headers.findIndex((h) => h.toLowerCase() === "production");

  if (localIdx === -1 || prodIdx === -1) {
    throw new Error('CSV must have "Local" and "Production" columns');
  }

  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim());
    return { local: cols[localIdx], production: cols[prodIdx] };
  });
}

/**
 * Capture a full-page screenshot and collect key DOM metrics for comparison.
 */
async function capturePage(page, url, screenshotPath) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const metrics = await page.evaluate(() => {
    const getText = () => document.body.innerText.trim().slice(0, 5000);
    const getLinks = () =>
      [...document.querySelectorAll("a[href]")]
        .map((a) => a.getAttribute("href"))
        .sort()
        .join("|");
    const getHeadings = () =>
      [...document.querySelectorAll("h1,h2,h3")]
        .map((el) => el.innerText.trim())
        .join("|");
    const getImages = () => document.querySelectorAll("img").length;
    const getButtons = () =>
      [...document.querySelectorAll("button, [type=submit]")]
        .map((b) => b.innerText.trim())
        .join("|");
    const getTitle = () => document.title;
    const getMetaDesc = () => {
      const m = document.querySelector('meta[name="description"]');
      return m ? m.getAttribute("content") : "";
    };
    return {
      title: getTitle(),
      metaDescription: getMetaDesc(),
      headings: getHeadings(),
      text: getText(),
      links: getLinks(),
      imageCount: getImages(),
      buttons: getButtons(),
    };
  });

  return metrics;
}

/**
 * Compute a similarity score (0–1) between two metric objects.
 * Weighted average of several signals.
 */
function computeSimilarity(a, b) {
  const strSim = (s1, s2) => {
    if (!s1 && !s2) return 1;
    if (!s1 || !s2) return 0;
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    const longerLen = longer.length;
    if (longerLen === 0) return 1;
    const editDist = levenshtein(longer, shorter);
    return (longerLen - editDist) / longerLen;
  };

  // Levenshtein on first 300 chars to keep it fast
  const levenshtein = (s1, s2) => {
    s1 = s1.slice(0, 300);
    s2 = s2.slice(0, 300);
    const dp = Array.from({ length: s1.length + 1 }, (_, i) =>
      Array.from({ length: s2.length + 1 }, (_, j) =>
        i === 0 ? j : j === 0 ? i : 0,
      ),
    );
    for (let i = 1; i <= s1.length; i++) {
      for (let j = 1; j <= s2.length; j++) {
        dp[i][j] =
          s1[i - 1] === s2[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[s1.length][s2.length];
  };

  const weights = {
    title: 0.15,
    metaDesc: 0.1,
    headings: 0.25,
    text: 0.3,
    links: 0.1,
    imageCount: 0.05,
    buttons: 0.05,
  };

  const scores = {
    title: strSim(a.title, b.title),
    metaDesc: strSim(a.metaDescription, b.metaDescription),
    headings: strSim(a.headings, b.headings),
    text: strSim(a.text, b.text),
    links: strSim(a.links, b.links),
    imageCount:
      a.imageCount === b.imageCount
        ? 1
        : 1 -
          Math.abs(a.imageCount - b.imageCount) /
            Math.max(a.imageCount, b.imageCount, 1),
    buttons: strSim(a.buttons, b.buttons),
  };

  const total = Object.keys(weights).reduce(
    (sum, k) => sum + weights[k] * scores[k],
    0,
  );
  return { score: total, details: scores };
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(SCREENSHOT_DIR))
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const urlPairs = parseCSV(CSV_FILE);
  console.log(`Found ${urlPairs.length} URL pair(s) to compare.\n`);

  const browser = await chromium.launch({ headless: true });
  const results = [];

  for (let i = 0; i < urlPairs.length; i++) {
    const { local, production } = urlPairs[i];
    console.log(`[${i + 1}/${urlPairs.length}] Comparing:`);
    console.log(`  Local      : ${local}`);
    console.log(`  Production : ${production}`);

    const slug = (url) =>
      url
        .replace(/https?:\/\//, "")
        .replace(/[^a-zA-Z0-9]/g, "_")
        .slice(0, 60);

    const localScreenshot = path.join(
      SCREENSHOT_DIR,
      `${i + 1}_local_${slug(local)}.png`,
    );
    const prodScreenshot = path.join(
      SCREENSHOT_DIR,
      `${i + 1}_prod_${slug(production)}.png`,
    );

    let localMetrics, prodMetrics, similarity, match, notes;

    try {
      const page = await browser.newPage();
      await page.setViewportSize(VIEWPORT);

      // ── Local
      try {
        localMetrics = await capturePage(page, local, localScreenshot);
      } catch (err) {
        console.error(`  ⚠ Failed to load local URL: ${err.message}`);
        localMetrics = null;
      }

      // ── Production
      try {
        prodMetrics = await capturePage(page, production, prodScreenshot);
      } catch (err) {
        console.error(`  ⚠ Failed to load production URL: ${err.message}`);
        prodMetrics = null;
      }

      await page.close();

      if (localMetrics && prodMetrics) {
        const result = computeSimilarity(localMetrics, prodMetrics);
        similarity = +(result.score * 100).toFixed(1);
        match = result.score >= MATCH_THRESHOLD ? "YES" : "NO";
        notes = Object.entries(result.details)
          .map(([k, v]) => `${k}:${(v * 100).toFixed(0)}%`)
          .join(" | ");
        console.log(`  ✓ Similarity: ${similarity}%  →  Match: ${match}`);
      } else {
        similarity = 0;
        match = "ERROR";
        notes = "One or both pages failed to load";
        console.log(`  ✗ Could not compare (load error)`);
      }
    } catch (err) {
      similarity = 0;
      match = "ERROR";
      notes = err.message;
      console.error(`  ✗ Error: ${err.message}`);
    }

    results.push({
      local,
      production,
      match,
      similarityPct: similarity,
      localScreenshot: fs.existsSync(localScreenshot) ? localScreenshot : "N/A",
      prodScreenshot: fs.existsSync(prodScreenshot) ? prodScreenshot : "N/A",
      notes,
    });

    console.log("");
  }

  await browser.close();

  // ─── Write Excel ───────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = "UI Compare Script";
  wb.created = new Date();

  const ws = wb.addWorksheet("UI Comparison Results");

  // Header style
  const headerFill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1F4E79" },
  };
  const headerFont = {
    name: "Arial",
    size: 11,
    bold: true,
    color: { argb: "FFFFFFFF" },
  };
  const borderStyle = { style: "thin", color: { argb: "FFBFBFBF" } };
  const allBorders = {
    top: borderStyle,
    left: borderStyle,
    bottom: borderStyle,
    right: borderStyle,
  };

  ws.columns = [
    { header: "Local URL", key: "local", width: 50 },
    { header: "Production URL", key: "production", width: 50 },
    { header: "Match", key: "match", width: 10 },
    { header: "Similarity (%)", key: "similarityPct", width: 16 },
    { header: "Score Breakdown", key: "notes", width: 70 },
    { header: "Local Screenshot", key: "localScreenshot", width: 55 },
    { header: "Prod Screenshot", key: "prodScreenshot", width: 55 },
  ];

  // Style header row
  ws.getRow(1).eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.border = allBorders;
    cell.alignment = {
      horizontal: "center",
      vertical: "middle",
      wrapText: true,
    };
  });
  ws.getRow(1).height = 30;

  // Data rows
  results.forEach((r, idx) => {
    const row = ws.addRow(r);
    row.height = 22;

    row.eachCell((cell) => {
      cell.border = allBorders;
      cell.font = { name: "Arial", size: 10 };
      cell.alignment = { vertical: "middle", wrapText: false };
    });

    // Colour-code the Match cell
    const matchCell = row.getCell("match");
    matchCell.font = { name: "Arial", size: 10, bold: true };
    matchCell.alignment = { horizontal: "center", vertical: "middle" };
    if (r.match === "YES") {
      matchCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF92D050" },
      }; // green
    } else if (r.match === "NO") {
      matchCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFF0000" },
      }; // red
      matchCell.font.color = { argb: "FFFFFFFF" };
    } else {
      matchCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFC000" },
      }; // amber
    }

    // Zebra stripe
    if (idx % 2 === 0) {
      [
        "local",
        "production",
        "similarityPct",
        "notes",
        "localScreenshot",
        "prodScreenshot",
      ].forEach((k) => {
        const c = row.getCell(k);
        if (!c.fill || c.fill.pattern === "none") {
          c.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFF2F2F2" },
          };
        }
      });
    }
  });

  // Summary sheet
  const summary = wb.addWorksheet("Summary");
  const total = results.length;
  const yes = results.filter((r) => r.match === "YES").length;
  const no = results.filter((r) => r.match === "NO").length;
  const errors = results.filter((r) => r.match === "ERROR").length;

  summary.columns = [
    { key: "label", width: 25 },
    { key: "value", width: 15 },
  ];
  [
    ["Total URLs Compared", total],
    ["Matching (YES)", yes],
    ["Not Matching (NO)", no],
    ["Errors", errors],
    ["Match Rate", `=B3/B2`],
  ].forEach(([label, value], i) => {
    const row = summary.addRow({ label, value });
    row.getCell("label").font = { name: "Arial", size: 11, bold: true };
    row.getCell("value").font = { name: "Arial", size: 11 };
    if (i === 4) {
      row.getCell("value").numFmt = "0.0%";
    }
  });

  await wb.xlsx.writeFile(OUTPUT_FILE);
  console.log(`\n✅ Results saved to: ${OUTPUT_FILE}`);
  console.log(`📁 Screenshots saved to: ${SCREENSHOT_DIR}/`);
})();
