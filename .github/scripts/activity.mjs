// Counts commits on default branches and merged pull requests per month across
// every repository in the org, public and private, then renders them as SVG.
//
// No dependencies. The counts are written next to the chart so the picture can
// be checked against the numbers it was drawn from.
//
//   ACTIVITY_TOKEN=... node .github/scripts/activity.mjs            measure and render
//   node .github/scripts/activity.mjs --from profile/activity.json  render only

import { readFile, writeFile } from "node:fs/promises";

const ORG = "x-mesh";
const MONTHS = 12;
const OUT_DATA = "profile/activity.json";
const OUT_LIGHT = "profile/assets/activity.svg";
const OUT_DARK = "profile/assets/activity.dark.svg";

async function graphql(token, query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL ${res.status}: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

function monthWindows(now) {
  const windows = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    windows.push({ month: start.toISOString().slice(0, 7), start, end });
  }
  return windows;
}

async function listRepos(token) {
  const repos = [];
  let cursor = null;
  do {
    const data = await graphql(
      token,
      `query($org: String!, $cursor: String) {
        organization(login: $org) {
          repositories(first: 100, after: $cursor, isFork: false) {
            nodes { name isPrivate defaultBranchRef { name } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { org: ORG, cursor },
    );
    const page = data.organization.repositories;
    repos.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return repos;
}

async function commitsPerMonth(token, repo, windows) {
  if (!repo.defaultBranchRef) return windows.map(() => 0);
  const fields = windows
    .map(
      (w, i) =>
        `m${i}: history(since: "${w.start.toISOString()}", until: "${w.end.toISOString()}") { totalCount }`,
    )
    .join("\n");
  const data = await graphql(
    token,
    `query($org: String!, $name: String!) {
      repository(owner: $org, name: $name) {
        defaultBranchRef { target { ... on Commit { ${fields} } } }
      }
    }`,
    { org: ORG, name: repo.name },
  );
  const target = data.repository.defaultBranchRef.target;
  return windows.map((_, i) => target[`m${i}`].totalCount);
}

async function mergedPullsPerMonth(token, windows) {
  const day = (d) => d.toISOString().slice(0, 10);
  const fields = windows
    .map((w, i) => {
      const last = new Date(w.end.getTime() - 86400000);
      const q = `org:${ORG} is:pr is:merged merged:${day(w.start)}..${day(last)}`;
      return `m${i}: search(type: ISSUE, query: ${JSON.stringify(q)}, first: 1) { issueCount }`;
    })
    .join("\n");
  const data = await graphql(token, `query { ${fields} }`);
  return windows.map((_, i) => data[`m${i}`].issueCount);
}

async function measure(token) {
  const now = new Date();
  const windows = monthWindows(now);
  const repos = await listRepos(token);
  const commits = windows.map(() => 0);
  for (const repo of repos) {
    const counts = await commitsPerMonth(token, repo, windows);
    counts.forEach((n, i) => (commits[i] += n));
  }
  const merged = await mergedPullsPerMonth(token, windows);
  return {
    org: ORG,
    measuredAt: now.toISOString(),
    repositories: { total: repos.length, private: repos.filter((r) => r.isPrivate).length },
    months: windows.map((w, i) => ({ month: w.month, commits: commits[i], mergedPulls: merged[i] })),
  };
}

const PALETTES = {
  light: { bg: "#ffffff", text: "#1f2328", dim: "#59636e", grid: "#d1d9e0", commits: "#0969da", pulls: "#8250df" },
  dark: { bg: "#0d1117", text: "#f0f6fc", dim: "#9198a1", grid: "#3d444d", commits: "#4493f8", pulls: "#ab7df8" },
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function escapeXml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function render(data, theme) {
  const p = PALETTES[theme];
  // Months before the first recorded activity carry no information, so they are dropped.
  const first = data.months.findIndex((m) => m.commits > 0 || m.mergedPulls > 0);
  const months = first === -1 ? data.months : data.months.slice(first);
  const current = data.measuredAt.slice(0, 7);

  const width = 820;
  const left = 24;
  const right = 24;
  const slot = (width - left - right) / months.length;
  const panels = [
    { key: "commits", label: "commits on default branches", color: p.commits, top: 92, height: 120 },
    { key: "mergedPulls", label: "merged pull requests", color: p.pulls, top: 262, height: 80 },
  ];
  const axisY = 362;
  const height = 404;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">`,
    `<rect width="${width}" height="${height}" rx="8" fill="${p.bg}"/>`,
    `<text x="${left}" y="34" font-size="15" font-weight="600" fill="${p.text}">${escapeXml(data.org)} &#183; activity per month</text>`,
    `<text x="${left}" y="54" font-size="11" fill="${p.dim}">all ${data.repositories.total} repositories, ${data.repositories.private} of them private &#183; measured ${data.measuredAt.slice(0, 10)} UTC &#183; current month to date</text>`,
  );

  for (const panel of panels) {
    const max = Math.max(1, ...months.map((m) => m[panel.key]));
    const base = panel.top + panel.height;
    parts.push(
      `<text x="${left}" y="${panel.top - 14}" font-size="12" font-weight="600" fill="${panel.color}">${escapeXml(panel.label)}</text>`,
      `<line x1="${left}" y1="${base}" x2="${width - right}" y2="${base}" stroke="${p.grid}"/>`,
    );
    const points = months.map((m, i) => ({
      x: left + slot * i + slot / 2,
      y: base - (m[panel.key] / max) * (panel.height - 22),
      value: m[panel.key],
      partial: m.month === current,
    }));
    const xy = (pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
    // The current month is still being counted, so the segment into it is dashed.
    const settled = points[points.length - 1].partial ? points.slice(0, -1) : points;
    parts.push(
      `<path d="M${xy(points[0])} ${points.slice(1).map((pt) => `L${xy(pt)}`).join(" ")} L${points[points.length - 1].x.toFixed(1)},${base} L${points[0].x.toFixed(1)},${base} Z" fill="${panel.color}" fill-opacity="0.12"/>`,
    );
    if (settled.length > 1) {
      parts.push(
        `<polyline points="${settled.map(xy).join(" ")}" fill="none" stroke="${panel.color}" stroke-width="2" stroke-linejoin="round"/>`,
      );
    }
    if (settled.length < points.length && settled.length > 0) {
      parts.push(
        `<polyline points="${xy(settled[settled.length - 1])} ${xy(points[points.length - 1])}" fill="none" stroke="${panel.color}" stroke-width="2" stroke-dasharray="4 3"/>`,
      );
    }
    for (const pt of points) {
      parts.push(
        `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="3" fill="${pt.partial ? p.bg : panel.color}" stroke="${panel.color}" stroke-width="1.5"/>`,
        `<text x="${pt.x.toFixed(1)}" y="${(pt.y - 8).toFixed(1)}" font-size="10" text-anchor="middle" fill="${p.dim}">${pt.value.toLocaleString("en-US")}</text>`,
      );
    }
  }

  months.forEach((m, i) => {
    const [y, mo] = m.month.split("-").map(Number);
    const x = left + slot * i + slot / 2;
    const showYear = i === 0 || mo === 1;
    parts.push(
      `<text x="${x.toFixed(1)}" y="${axisY + 4}" font-size="11" text-anchor="middle" fill="${p.dim}">${MONTH_NAMES[mo - 1]}</text>`,
    );
    if (showYear) {
      parts.push(`<text x="${x.toFixed(1)}" y="${axisY + 20}" font-size="10" text-anchor="middle" fill="${p.dim}">${y}</text>`);
    }
  });

  parts.push("</svg>");
  return parts.join("\n") + "\n";
}

async function main() {
  const fromIndex = process.argv.indexOf("--from");
  let data;
  if (fromIndex !== -1) {
    data = JSON.parse(await readFile(process.argv[fromIndex + 1], "utf8"));
  } else {
    const token = process.env.ACTIVITY_TOKEN;
    if (!token) {
      // Without a token that can see private repositories the chart would silently
      // under-count, so refuse instead of drawing a smaller number.
      throw new Error("ACTIVITY_TOKEN is not set; it needs read access to every repository in the org");
    }
    data = await measure(token);
    await writeFile(OUT_DATA, JSON.stringify(data, null, 2) + "\n");
  }
  await writeFile(OUT_LIGHT, render(data, "light"));
  await writeFile(OUT_DARK, render(data, "dark"));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
