# Imports discovery (CSV and Excel)

This note is for R1-11a. It settles the open parameters in FR 8 for CSV and Excel. It does not implement imports.

Branch base is `origin/main` at `909150b`. D-023 and D-024 are in open docs PR #31 (`258a7a8`), not in that commit. This spike follows them: the customer workbooks were read in place and are not in the repository, and no row from them is quoted here.

Representative files, outside the repo:

- `/Users/stephenforte/airtable-shipping-tools/Updated_Rates_2025-09-06_2pct.xlsx` (920,841 bytes)
- `/Users/stephenforte/airtable-shipping-tools/ONE_Carrier_Sailings.xlsx` (818,648 bytes)
- `/Users/stephenforte/airtable-shipping-tools/Updated_Rates_2025-09-06_2pct.numbers` is out of scope (D-024). Round 1 does not read it. The import screen should tell the user to export Numbers to `.xlsx`.

No `.xls` file was in the set, so `.xls` stays out (D-017). PDF and unstructured extraction stay out (D-018).

Measurements used Node v22.21.0 (`/tmp/r1-10-bench/node-v22.21.0-darwin-arm64/bin/node`). The login `node` on this Mac was v26.9.0. The machine timezone was `America/Los_Angeles`.

## Planner's first look

Confirmed:

- Rates sheet `Updated_Rates_20251007`: 1,554 data rows, 17 columns, in this order: Rate Type, Origin Port, Destination Port/Via Port, Inland Delivery Location, Carrier, Contract Number, Contract Owner, 20D Rate, 40D rate, 40HC Rate, Validity, Effective Date, Expiry Date, Notes 1, Notes 2, Notes 3, Note 4.
- Second sheet `Summary`: not a rate table. Dimension `A1:B35`, 35 rows, 61 cells.
- Sailings sheet `ONE_Sailings` only: 2,254 data rows, 9 columns: Transit Time, Carrier, Departure, Arrival, Departure Port, Arrival Port, Voyage, Service, Vessel.
- Rates dates are Excel serials. Sailings dates are ISO text. Validity is free text. Prices can be fractional. Contract Number, Notes 2, Notes 3, and Note 4 have no `rates` column. Arrival Port has no `sailings` column.

Corrected from the files:

- The fractional day does not vary. All 3,108 rate date cells (effective and expiry) have fractional part `0.7083333333357587`, which is 17/24 within `2.4e-12` (17:00:00). The number format is builtin 14 (`mm-dd-yy`), so Excel does not show the time.
- Empty cells are omitted from the worksheet XML. That is every rates row: Contract Number is omitted on all 1,554 rows, Note 4 on all 1,554, Inland Delivery Location on 738, Notes 2 on 1,454, Notes 3 on 1,333. Sailings has no omitted cells.
- There is no `xl/sharedStrings.xml`. Strings are inline `t="str"` cells.
- Header casing is part of the file. The forty-foot column is `40D rate`, not `40D Rate`. The last note column is `Note 4`, not `Notes 4`.
- Validity is `Mon D - Mon D` on all 1,554 rows (no year). Its month and day match the floored effective and expiry dates on all 1,554 rows.
- Every price cell is filled (no blanks, no zeros, no negatives). All 4,662 prices are exact cents, and `price / 1.02` is a whole number within `1.8e-12`. The decimals are a 2% uplift of whole-dollar rates.
- Sailings departure and arrival match `YYYY-MM-DD` on all 2,254 rows. Arrival is never before departure. Transit Time is an integer from 20 to 23. The sailings workbook has no date number format (`numFmtId` 0 only).

## 1. Parser

Use two runtime dependencies. This pull request does not add them.

- Excel: `read-excel-file@9.3.12`
- CSV: `csv-parse@7.0.3`

`read-excel-file` is the one to call for `.xlsx`. It was the smallest install, the lowest peak memory, the fastest warm parse, the most recently published, and `npm audit` reported nothing for it. It kept omitted cells in place, returned both sheets, read the inline strings, and its dates matched the Excel calendar date (section 3).

### Candidates

Published dates are `npm view <pkg> time.modified`. Install size is `du -sk node_modules` after a clean `npm install <pkg>@<version>` on 2026-10-13. Audit is `npm audit` in one tree that installed every candidate together.

| Package | Version | Published | Audit | Install |
| --- | --- | --- | --- | --- |
| `read-excel-file` | 9.3.12 | 2026-10-07 | none | 5,676 KB |
| `exceljs` | 4.4.0 | 2024-12-20 | moderate `uuid` [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) (`uuid` < 11.1.1, missing buffer bounds check when `buf` is provided) | 51,232 KB |
| `xlsx` (SheetJS on npm) | 0.18.5 | republished 2026-07-17; version still 0.18.5 | high [GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6) prototype pollution (< 0.19.3) and [GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9) ReDoS (< 0.20.2) | 14,356 KB |
| `@e965/xlsx` | 0.20.3 | 2024-07-19 | none in this audit | 7,960 KB |
| `csv-parse` | 7.0.3 | 2026-09-25 | none | 1,652 KB |
| `papaparse` | 5.7.0 | 2026-08-24 | none | 332 KB |
| `fast-csv` | 5.0.8 | 2026-10-05 | none | 368 KB |

`@e965/xlsx` is an unofficial republish that contains the SheetJS fixes missing from npm `xlsx`. It is stale, and `cellDates: true` has the same timezone trap as npm `xlsx`. Do not use either SheetJS package.

### Parse time and peak memory

Comparison parses ran three times per file after the packages were already on disk. The first sample includes loading the module. Later samples are warm parses. Peak RSS is `/usr/bin/time -l` for that process (`maximum resident set size`, bytes). An empty `node -e` on the same binary was 41,304,064 bytes.

Command, from `/tmp/r1-10-bench/parsers` with `NODE_PATH` set to that `node_modules`:

```text
/usr/bin/time -l /tmp/r1-10-bench/node-v22.21.0-darwin-arm64/bin/node /tmp/r1-10-bench/bench.js <exceljs|xlsx|e965|read-excel-file>
```

| Library | Rates ms (3 runs) | Sailings ms (3 runs) | Process max RSS |
| --- | --- | --- | --- |
| `read-excel-file@9.3.12` | 69.89, 25.08, 24.18 | 18.58, 30.23, 17.91 | 117,506,048 |
| `exceljs@4.4.0` | 292.89, 43.00, 46.61 | 37.83, 32.64, 34.34 | 160,694,272 |
| `xlsx@0.18.5` `cellDates: false`, then `true` | false: 132.74, 36.84, 39.46; true: 46.82, 32.53, 32.38 | false: 27.40, 25.43, 34.58; true: 25.40, 25.24, 25.75 | 154,632,192 |
| `@e965/xlsx@0.20.3` `cellDates: false`, then `true` | false: 144.98, 44.41, 47.71; true: 57.73, 40.75, 43.94 | false: 36.48, 32.60, 32.78; true: 37.84, 33.32, 33.39 | 152,649,728 |

Those RSS figures cover a process that parsed both workbooks three times (and, for the SheetJS rows, both `cellDates` modes). A single `read-excel-file` process that parsed one file twice:

```text
/usr/bin/time -l node /tmp/r1-10-bench/scale-bench.js parse <file>
```

| File | Bytes | Data rows | Sheets | Parse ms | Max RSS |
| --- | --- | --- | --- | --- | --- |
| Rates workbook | 920,841 | 1,554 | 2 | 35.34, 28.65 | 83,591,168 |
| Sailings workbook | 818,648 | 2,254 | 1 | 34.87, 24.22 | 80,265,216 |

Larger synthetic workbooks (invented cells only), same command:

| Rows | Bytes | Parse ms | Max RSS |
| --- | --- | --- | --- |
| 5,000 | 143,280 | 47.81, 39.40 | 88,178,688 |
| 10,000 | 279,298 | 88.17, 57.46 | 115,179,520 |
| 20,000 | 551,973 | 127.55, 103.33 | 142,180,352 |
| 22,000 unique long notes | 5,092,388 | 175.80, 145.16 | 185,188,352 |

### Omitted cells, dates, sheets

All four Excel libraries, used as below, kept columns aligned on both customer workbooks: the 20D column was a finite number on all 1,554 rows, and Contract Number (always absent from the XML) was empty on all 1,554. A later step that drops holes would slide Contract Owner into the price column. Keep the holes.

- `read-excel-file`: `const readXlsxFile = require('read-excel-file/node'); const sheets = await readXlsxFile(input, { trim: false });` Each entry is `{ sheet, data }`. `data` is a rectangular array; missing cells are `null`. Pass `trim: false`. The default trim removed the fixture origin `  Padded Port  ` before the caller saw it.
- `exceljs`: `worksheet.getSheetValues()` is 1-based and sparse. Slicing off the leading hole keeps the column index. Dates come back as `Date`.
- `xlsx` / `@e965/xlsx`: `sheet_to_json(sheet, { header: 1, raw: true, defval: null })` keeps holes. `cellDates: false` leaves serial numbers. `cellDates: true` builds a local `Date` (section 3).

`read-excel-file` returned both rates sheets by name (`Updated_Rates_20251007` and `Summary`, 35 summary rows) and the one sailings sheet.

### CSV

No customer CSV was supplied. CSV timings are a rectangular UTF-8 transcription of the two worksheet XML parts (same cell text, omitted cells written as empty fields), parsed and then deleted. Transcription sizes: rates 306,812 bytes, sailings 157,701 bytes.

```text
/usr/bin/time -l node /tmp/r1-10-bench/csv-bench.js
```

Process max RSS 106,037,248 (all three parsers, both transcriptions, three times).

| Parser | Rates ms | Rates shape | Sailings ms | Sailings shape |
| --- | --- | --- | --- | --- |
| `csv-parse@7.0.3` `{ bom: true }` | 13.81, 11.40, 6.19 | 1,555 × 17 | 4.16, 3.77, 3.62 | 2,255 × 9 |
| `papaparse@5.7.0` default | 4.31, 1.88, 2.51 | 1,556 × 17 | 1.95, 1.92, 1.02 | 2,256 × 9 |
| `fast-csv@5.0.8` `parseString` | 22.01, 15.93, 10.74 | 1,555 × 17 | 7.43, 7.06, 7.25 | 2,255 × 9 |

`papaparse` added one empty row because the transcription ended in a newline and `skipEmptyLines` was left off. `csv-parse` and `fast-csv` returned the real row count (header plus data).

On a synthetic string, `csv-parse` with `{ bom: true }` stripped a UTF-8 BOM, kept a comma inside quotes, turned `""` into `"`, kept a newline inside quotes, and decoded a UTF-16 LE BOM to `Ada, Oslo` without a separate encoding argument. `papaparse` did the same for the UTF-8 case. `fast-csv` stripped the BOM, kept the comma, and undoubled the quote.

A synthetic blank line makes default `csv-parse` throw `CSV_RECORD_INCONSISTENT_FIELDS_LENGTH` (the blank line is one empty field). `{ skip_empty_lines: true }` drops it. A short row throws the same way; `{ relax_column_count: true }` returns the short row. Pad that row to the header width with `null`. Do not shift later columns left.

Call:

```js
const { parse } = require('csv-parse/sync');
const rows = parse(buffer, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true
});
```

Leave parser trim off and trim in the shared conversion, same as Excel. The file is UTF-8 unless a BOM says UTF-16. `csv-parse` honored both BOMs in the synthetic check. Reject a file that does not decode.

`rates.csv` in the fixtures starts with a UTF-8 BOM and includes a quoted comma and a doubled quote, so this path can be tested without a customer file.

## 2. Column map

Validation field names are `lib/record-validation.js`. Database columns are `lib/db.js`. The server assigns `id`, `owner_company_id`, `row_version`, and `deleted_at`. A mapping must not set them (FR 8). `commodity_type` and `rate_view` are not in either workbook; store `null`.

### Rates

| Source header | Validation field | Column | This file | What to do |
| --- | --- | --- | --- | --- |
| Rate Type | `rateType` | `rate_type` | 1,554 text | Optional text |
| Origin Port | `originPort` | `origin_port` | 1,554 text | Required |
| Destination Port/Via Port | `destinationPort` | `destination_port` | 1,554 text | Required |
| Inland Delivery Location | `inlandDeliveryLocation` | `inland_delivery_location` | 816 text, 738 omitted | Optional. Omitted is `null` |
| Carrier | `carrier` | `carrier` | 1,554 text | Required |
| Contract Number | none | none | 0 filled | No column. See the decision below |
| Contract Owner | `contractOwner` | `contract_owner` | 1,554 text | Optional text. This is not `owner_company_id` |
| 20D Rate | `rate20D` | `rate_20d` | 1,554 numbers | Price rule below |
| 40D rate | `rate40D` | `rate_40d` | 1,554 numbers | Match this header as written |
| 40HC Rate | `rate40HC` | `rate_40hc` | 1,554 numbers | Price rule below |
| Validity | none | none | 1,554 text, no year | Ignore. Do not parse it into the date columns |
| Effective Date | `rateEffectiveDate` | `rate_effective_date` | 1,554 serials, format 14 | Required. Section 3 |
| Expiry Date | `rateExpirationDate` | `rate_expiration_date` | 1,554 serials, format 14 | Required. Section 3 |
| Notes 1 | `notes1` | `notes_1` | 1,554 text | Optional text, then append the extras below |
| Notes 2 | none | none | 100 text | Append when non-blank |
| Notes 3 | none | none | 221 text | Append when non-blank |
| Note 4 | none | none | 0 text | Append when non-blank. Header is `Note 4` |

Append, after trim, skipping blanks, in this order, separated by newlines: the Notes 1 body, then `Contract Number: …`, `Notes 2: …`, `Notes 3: …`, `Note 4: …`. If nothing remains, `notes1` is `null`. On this workbook the contract-number and Note 4 pieces add nothing, and Validity is not appended: it restates the floored dates and has no year.

`validateRate` requires origin, destination, carrier, both dates as `YYYY-MM-DD`, expiry not before effective, and at least one finite nonnegative price. After the rules in section 3, all 1,554 rows pass. None have an inverted date range. The gaps are columns the file does not have (`commodity_type`, `rate_view`) and columns the table does not have (Contract Number, Validity, Notes 2, Notes 3, Note 4), not missing required values.

### Sailings

| Source header | Validation field | Column | This file | What to do |
| --- | --- | --- | --- | --- |
| Transit Time | `transitTime` | `transit_time` | 2,254 integers | The column is TEXT and `optionalText` rejects a number. Store `String(value)` |
| Carrier | `carrier` | `carrier` | 2,254 text | Required |
| Departure | `departure` | `departure` | 2,254 `YYYY-MM-DD` | Required. Pass the text through. Do not turn it into a zoned timestamp |
| Arrival | `arrival` | `arrival` | 2,254 `YYYY-MM-DD` | Optional. Never before departure (0 such rows here) |
| Departure Port | `departurePort` | `departure_port` | 2,254 text | Required |
| Arrival Port | none | none | 2,254 text | No column and no notes column. See the decision below |
| Voyage | `voyage` | `voyage` | 2,254 text | Optional |
| Service | `service` | `service` | 2,254 text | Optional |
| Vessel | `vessel` | `vessel` | 2,254 text | Optional |

All 2,254 rows pass `validateSailing` once transit time is a string.

### Sheet choice

FR 8 lets the user select a sheet. List every sheet name. Preselect the only sheet whose first row contains the required headers for the chosen dataset (origin, destination, and carrier for rates; carrier, departure port, and departure for sailings). If none or more than one match, require a choice. Do not import `Summary`. One rates sheet matched; the sailings workbook has one sheet.

### Decisions for the operator

R1-11a can ship the defaults below. Change them only if the operator says so before that work.

1. **Contract Number.** There is no `contract_number` column. This workbook's column is empty (0 of 1,554). Default: when a future file has a value, append `Contract Number: …` to `notes_1`. Add a column only if the value must be searchable on its own. That would be a migration.
2. **Arrival Port.** `sailings` has no arrival-port column and no notes column, so the value cannot be appended. Default: leave it unmapped, show it that way in the mapping review, and do not store it. Add `arrival_port` only if sailings need to be filtered by it.

## 3. Conversion rules

### Excel serial dates

Store the calendar date Excel shows, as `YYYY-MM-DD`, using the 1900 date system and the integer day. Drop the time.

```js
function excelSerialToIso(serial) {
    const ms = Date.UTC(1899, 11, 30) + Math.floor(Number(serial)) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
}
```

Evidence, from the rates worksheet XML, compared with `Math.floor` of the serial:

- Fractional part is `0.7083333333357587` on all 3,108 date cells. `fraction * 24` is 17 hours plus less than a microsecond. It is one export time, not a set of sailing times.
- Number format 14 does not display a time. The date on screen is the integer day.
- `Math.round(serial)` disagrees with `Math.floor(serial)` on all 3,108 cells. Rounding moves every date forward one day. Do not round the serial.
- The UTC date of the full serial (fraction included) agrees with `Math.floor` on all 3,108 cells, because 17:00 does not cross UTC midnight.
- Validity's month and day agree with that floored date on all 1,554 rows. That is the date a person reads. Validity has no year, so it cannot be the source of the stored date.
- `read-excel-file` and `exceljs` return a `Date` whose UTC hour is 17 and whose UTC calendar date agrees with `Math.floor` on all 3,108 cells. Take `getUTCFullYear` / `getUTCMonth` / `getUTCDate` (or `toISOString().slice(0, 10)`).
- Local getters agreed with that UTC date on this Mac (`America/Los_Angeles`) for all 3,108 cells. They do not in every timezone. A synthetic `Date` at `2026-03-02T17:00:00.000Z` (the same clock time these cells use) is 2026-03-02 in `America/Los_Angeles` and `UTC`, and 2026-03-03 from `getFullYear`/`getDate` in `Asia/Tokyo`. Render and GitHub Actions run in UTC, so a local-getter bug would not show up in CI. Use the UTC calendar date.
- `xlsx` and `@e965/xlsx` with `cellDates: true` build `new Date(year, monthIndex, day, hours, …)` in local time. On this Mac the local calendar date matched all 3,108 cells and `toISOString().slice(0, 10)` matched none. That option is the day-shift. `cellDates: false` leaves the serial; `Math.floor` then matches all 3,108. We are not using those packages.

`read-excel-file` already returns the `Date`. Persist the UTC date, not the `Date` and not the 17:00. `parseDateOnly` accepts only `YYYY-MM-DD`.

ISO text (`YYYY-MM-DD`), which is every sailings date, is already that form. Pass it through after trim.

A slash date (`06/10/2026` in `rates-bad.xlsx`) or a month-name date without a year is ambiguous. FR 8 requires a user choice. Do not guess month/day order and do not invent a year from Validity. Show the choice; do not only emit `validateRate`'s "Must be a valid YYYY-MM-DD date." A serial with format 14, and ISO text, are not ambiguous.

### Decimal prices

Store the cent value. Do not round to a whole dollar on import.

`20D Rate`: 206 integers, 1,344 with one decimal, 4 with two. `40D rate` and `40HC Rate`: 559 integers, 841 with one decimal, 154 with two. All 4,662 are exact cents (`value * 100` is an integer) and `value / 1.02` is a whole number within `1.8e-12`. The product already shows whole dollars: `formatNumber` uses `maximumFractionDigits: 0`, and `customerPrice` / `baseRateAmount` use `Math.round`. Rounding again at import would drop the 2% that is in the workbook. `rate_*` columns are `REAL`. `containerPrice` accepts any finite nonnegative number.

For a number, store `Math.round(value * 100) / 100`. That undoes binary noise at the cent and does not change these cells. For numeric text, parse the same way after removing a leading `$` and thousands separators.

### Blank prices

Omitted or blank is `null`, never `0`. This workbook has no blank prices; `rates.xlsx` sheet row 3 omits 20D on purpose. `containerPrice` already returns `null` for `undefined`, `null`, and `''`. If all three prices are `null`, validation asks for one price.

Do not reuse `formatNumber`, `customerPrice`, or `baseRateAmount` during import. Each uses `Number(value) || 0`, so a blank becomes 0. `formatNumber` will also display a stored `null` as `$0` in the current browse table. That display path is outside this spike. Import must still store `null`.

### Non-USD

These price cells are numbers, with no currency text. FR 8 rejects non-USD and does not convert. If the cell is text, accept only an optional `$`, digits, thousands separators, and a decimal. Reject other symbols or codes (`EUR`, `€`, `GBP`, `£`, and the same kind of marker). `rates-bad.xlsx` puts `EUR 900` in 20D. Say that the price is not USD. Do not run it through an exchange rate.

A negative number fails `containerPrice` ("finite non-negative"). Keep that.

### Text

Trim every text field. This workbook had no leading or trailing spaces (0 cells). The fixture's sheet row 4 origin is `  Padded Port  `. After trim, an optional field that is empty is `null`. A required field that is empty fails validation.

`read-excel-file` trims by default. Pass `{ trim: false }` and trim once in conversion, shared with CSV.

### Sheets

Read the sheet the user confirmed. Ignore the others. `Summary` is a report (source dates, a 2% line, carrier counts, route counts). It is not rows.

## 4. Limits and retention

The Render service is the starter plan (512 MB). Both caps apply. Reject before parse when the byte cap fails. Reject after parse when the row cap fails, and write nothing.

| Limit | Value | Why |
| --- | --- | --- |
| File size | 5,000,000 bytes | The customer files are 920,841 and 818,648 bytes. A synthetic 5,092,388-byte workbook (22,000 rows) parsed in 175.80 ms then 145.16 ms at 185,188,352 bytes max RSS. The cap sits under that measured file. |
| Data rows | 10,000, not counting the header | The customer files are 1,554 and 2,254 data rows. A synthetic 10,000-row workbook parsed at 115,179,520 bytes max RSS (88.17 ms, then 57.46 ms). The 22,000-row file above also succeeded; 10,000 keeps the parser near a quarter of the 512 MB instance. |
| Claude sample | 5 data rows and 8,000 characters of sample JSON | Fixture sample is 1,322 characters (`JSON.stringify` of headers, five rows, nulls for omitted cells, dates as `YYYY-MM-DD`). The rates workbook's longest five-row sample is 1,886 characters; the first five are 1,387. The sailings first five are 573. All of those fit. |

Configurable, and shown before upload (FR 8). Names to use: `IMPORT_MAX_BYTES` (5000000), `IMPORT_MAX_ROWS` (10000), `IMPORT_SAMPLE_ROWS` (5), `IMPORT_SAMPLE_CHARS` (8000).

**Retention is 24 hours.** That is the period FR 8 requires. Delete the upload and the mapping sample (the headers and rows sent to Claude, and the model response) when the import is committed, when the user cancels, or 24 hours after upload, whichever comes first. Sweep expired files on startup. Operation history keeps actor, company, dataset, filename, byte size, sheet name, accepted and rejected counts, outcome, and timestamp. It does not keep the file, the cell values, the prompt, or the model output.

## 5. Claude mapping trial

D-016: server-side Messages API, model `IMPORT_MAPPING_MODEL`, default `claude-sonnet-5-5`, key `ANTHROPIC_API_KEY`. The model sees headers and this bounded sample only. If the response is not JSON matching the schema below, discard it and continue with manual mapping.

D-025 stores contract number and arrival port, so those headers are targets. Section 2's "no column" defaults are not what R1-11a ships. Validity, Notes 2, Notes 3, and Note 4 still have no target. The server appends the note columns. The model does not merge them and does not return cell values.

The live calls used the synthetic fixture only. No customer workbook row was sent.

The sample is the five `Fixture_Rates` rows. Dates in the sample are the UTC calendar dates from section 3, not the raw serials. Omitted cells are `null`. Compact JSON is 1,322 characters.

The sample that would have been sent is the five `Fixture_Rates` rows. Dates in the sample are the UTC calendar dates from section 3, not the raw serials. Omitted cells are `null`. Compact JSON is 1,322 characters.

```json
{
  "dataset": "rates",
  "headers": ["Rate Type", "Origin Port", "Destination Port/Via Port", "Inland Delivery Location", "Carrier", "Contract Number", "Contract Owner", "20D Rate", "40D rate", "40HC Rate", "Validity", "Effective Date", "Expiry Date", "Notes 1", "Notes 2", "Notes 3", "Note 4"],
  "rows": [
    ["FAK Base", "Fixture Harbor", "North Quay", "Depot A, ZZ", "Fixture Line", "FX-1001", "Example Owner", 1100.5, 2100.25, 2200, "Mar 2 - Mar 20", "2026-03-02", "2026-03-20", "Gate A, pier \"north\"", "Sample note two", "Sample note three", "Sample note four"],
    ["FAK Base", "Cedar Dock", "South Quay", null, "Fixture Line", null, "Example Owner", null, 1800.4, 1900, "Apr 1 - Apr 15", "2026-04-01", "2026-04-15", "No twenty-foot price on this row", null, null, null],
    ["FAK Base", "  Padded Port  ", "West Quay", "Yard B, ZZ", "Fixture Line", "FX-1002", "Example Owner", 999.99, 1500, null, "May 4 - May 18", "2026-05-04", "2026-05-18", "Origin has surrounding spaces", null, null, null],
    ["FAK Base", "East Quay", "North Quay", null, "Fixture Line", null, "Second Example", 800, 1400.1, 1450.55, "Jun 6 - Jun 10", "2026-06-06", "2026-06-10", "Two-decimal forty-foot high cube", null, "Only the third note is set", null],
    ["FAK Base", "Low Wharf", "South Quay", "Ramp C, ZZ", "Fixture Line", null, "Example Owner", 750.5, null, null, "Jul 7 - Jul 21", "2026-07-07", "2026-07-21", "Only a twenty-foot price", null, null, null]
  ]
}
```

A correct response maps each header to the validation field in section 2, with two D-025 changes: Contract Number maps to `contractNumber`, and on a sailings file Arrival Port maps to `arrivalPort`. Validity, Notes 2, Notes 3, and Note 4 map to `null`.

### Prompt

`lib/imports/schema.js` sends this as the user message. The sample JSON replaces the last line. The first live attempt, which did not show this shape, came back as an object keyed by header. That object does not match the schema, so the product discarded it. The prompt below is the one that was retried, and the one the server sends.

```text
Map each source header onto one Rate Ninja field. Return only a JSON object, no markdown.

Rules:
- Use a target at most once.
- If no target fits, use null. Do not invent a field.
- Do not map Validity, Notes 2, Notes 3, or Note 4 onto another field. They have no target.
- Do not convert prices or dates. Do not fill empty cells.
- confidence is high, medium, or low. reason is one short sentence.
- Return header-to-field pairs only. Do not return cell values.
- Use this JSON shape and no other keys. One mappings entry per header. target is a field id or null, never a cell value.
{"dataset":"rates","mappings":[{"source":"Origin Port","target":"originPort","confidence":"high","reason":"The header names the origin."}]}

Rate targets: rateType, originPort, destinationPort, inlandDeliveryLocation, commodityType, carrier, contractOwner, contractNumber, rate20D, rate40D, rate40HC, rateEffectiveDate, rateExpirationDate, notes1.
Sailing targets: carrier, departurePort, arrivalPort, departure, arrival, transitTime, vessel, voyage, service.

Sample:
<sample>
```

### Response schema

Discard the response when `JSON.parse` fails or any check below fails.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["dataset", "mappings"],
  "properties": {
    "dataset": { "enum": ["rates", "sailings"] },
    "mappings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["source", "target", "confidence", "reason"],
        "properties": {
          "source": { "type": "string" },
          "target": {
            "type": ["string", "null"],
            "enum": [
              "rateType", "originPort", "destinationPort", "inlandDeliveryLocation",
              "commodityType", "carrier", "contractOwner", "contractNumber", "rate20D", "rate40D",
              "rate40HC", "rateEffectiveDate", "rateExpirationDate", "notes1",
              "departurePort", "arrivalPort", "departure", "arrival", "transitTime", "vessel",
              "voyage", "service", null
            ]
          },
          "confidence": { "enum": ["high", "medium", "low"] },
          "reason": { "type": "string", "maxLength": 200 }
        }
      }
    }
  }
}
```

Also require: one mapping per sample header, `source` equal to that header, no repeated non-null `target`, and every non-null `target` legal for that dataset.

### Results

Model reported by the API: `claude-sonnet-5-5`. Price used: $2 per million input tokens and $10 per million output tokens (Anthropic list price for Claude Sonnet 5.5, standard global tier). No cache tokens.

Shipped prompt, fixture headers, five fixture rows. The response matched the schema. Contract Number mapped to `contractNumber` at high confidence. Validity, Notes 2, Notes 3, and Note 4 mapped to `null`. Input tokens 1,070. Output tokens 722. Cost $0.009360.

Renamed-header call, same five rows, `Origin Port` renamed to `From (POL)` and `20D Rate` renamed to `20ft $$$`. The response matched the schema. Both renamed headers mapped at high confidence: `From (POL)` to `originPort`, and `20ft $$$` to `rate20D`. That is the prompt failure this section defined. The product still shows the reason and the confidence, and manual mapping stays available. Input tokens 1,071. Output tokens 745. Cost $0.009592.

Two earlier calls, before the prompt stated the JSON shape, were discarded by the schema. Their combined cost was $0.041322 (input/output 976/719, 977/770, 976/756, and 977/1,106). Total spend for all six calls is $0.060274. No customer row was included.

## 6. Fixtures

`node scripts/generate-import-fixtures.js` writes `test/fixtures/imports/`. The script has no dependencies. Zip timestamps are fixed, so a second run is byte-identical. `npm test` only loads `test/**/*.test.js`, so these files are not tests.

| File | What it holds |
| --- | --- |
| `rates.xlsx` | Sheet `Fixture_Rates` (the five rows above) and a non-data `Summary` sheet. Omitted cells, serials with a 17/24 fraction, format 14, decimal prices, a blank 20D, free-text validity, unmapped columns, a padded origin, a quoted comma in Notes 1. Inline `t="str"`, no shared strings. |
| `rates.csv` | That rate sheet as UTF-8 CSV with a BOM. Empty fields keep the row rectangular. |
| `sailings.xlsx` | Sheet `Fixture_Sailings`. ISO dates, numeric transit time, one omitted vessel, one omitted arrival port. |
| `rates-bad.xlsx` | Four rows: omitted origin, effective date `06/10/2026`, 20D `-40`, 20D `EUR 900`. |
| `README.md` | The quirk list. |

## Out of scope

Imports themselves are R1-11a. PDF and unstructured extraction are deferred (D-018). Numbers files are not a format (D-024). Duplicate detection is P2. This spike does not add a runtime dependency, a migration, or product code.
