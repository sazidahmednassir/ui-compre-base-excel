# UI Compare

A Node.js tool that compares web pages between two environments (e.g. local vs. production) by capturing screenshots and computing a similarity score based on DOM metrics.

## How It Works

For each URL pair in the CSV file, the script:

1. Visits both URLs using a headless Chromium browser (Playwright)
2. Takes a full-page screenshot of each
3. Extracts DOM metrics: page title, meta description, headings, visible text, links, image count, and buttons
4. Computes a weighted similarity score (0–100%)
5. Flags the pair as **Match (YES/NO)** based on a configurable threshold
6. Outputs results to a formatted Excel workbook with a summary sheet

## Requirements

- Node.js 18+
- npm

## Setup

```bash
npm install
npx playwright install chromium
```

## Usage

1. Edit `Url_compare_Sheet1.csv` with your URL pairs:

```csv
Local,Production
http://localhost:3000/,https://example.com/
http://localhost:3000/about,https://example.com/about
```

2. Run the script:

```bash
node ui-compare.js
```

3. Results are saved to `ui-compare-results.xlsx` and screenshots to `screenshots/`.

## Configuration

Open [ui-compare.js](ui-compare.js) and adjust the constants at the top:

| Constant          | Default | Description                                      |
|-------------------|---------|--------------------------------------------------|
| `MATCH_THRESHOLD` | `0.85`  | Minimum similarity score (0–1) to count as match |
| `VIEWPORT`        | `1280x900` | Browser viewport for screenshots             |
| `CSV_FILE`        | `Url_compare_Sheet1.csv` | Input CSV path                  |
| `OUTPUT_FILE`     | `ui-compare-results.xlsx` | Output Excel path              |

## Similarity Score Breakdown

The score is a weighted average of these signals:

| Signal       | Weight |
|--------------|--------|
| Text content | 30%    |
| Headings     | 25%    |
| Page title   | 15%    |
| Meta desc    | 10%    |
| Links        | 10%    |
| Image count  | 5%     |
| Buttons      | 5%     |

## Output

- **ui-compare-results.xlsx** — row-by-row results with colour-coded Match column (green/red/amber) and a Summary sheet
- **screenshots/** — PNG screenshots named `{index}_{local|prod}_{slug}.png`
