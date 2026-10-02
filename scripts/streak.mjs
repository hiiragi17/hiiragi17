// JST (UTC+9) 基準の連続コントリビューション日数を集計して SVG を生成する。
// 必要: 環境変数 GH_TOKEN (read:user + repo)、USERNAME
import { writeFileSync, mkdirSync } from "node:fs";

const user = process.env.USERNAME;
const token = process.env.GH_TOKEN;
const OFFSET = 9 * 3600 * 1000;
const jstDay = (iso) => new Date(new Date(iso).getTime() + OFFSET).toISOString().slice(0, 10);

const commitQuery = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      commitContributionsByRepository(maxRepositories: 100) {
        contributions(first: 100) { nodes { occurredAt commitCount } }
      }
    }
  }
}`;

// PR / レビュー / Issue は 100 件を超えうるのでカーソルでページングする
const pagedQuery = (field) => `
query($login: String!, $from: DateTime!, $to: DateTime!, $after: String) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      ${field}(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { occurredAt }
      }
    }
  }
}`;

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? res.status));
  return json.data.user.contributionsCollection;
}

const days = new Map();
const add = (iso, n = 1) => days.set(jstDay(iso), (days.get(jstDay(iso)) ?? 0) + n);

// 直近 1 年を 3 か月ごとに取得
const now = new Date();
for (let i = 0; i < 4; i++) {
  const to = new Date(now.getTime() - i * 91 * 86400000);
  const from = new Date(to.getTime() - 91 * 86400000);
  const range = { login: user, from: from.toISOString(), to: to.toISOString() };

  const c = await gql(commitQuery, range);
  for (const r of c.commitContributionsByRepository)
    r.contributions.nodes.forEach((n) => add(n.occurredAt, n.commitCount));

  for (const field of ["pullRequestContributions", "pullRequestReviewContributions", "issueContributions"]) {
    let after = null;
    do {
      const conn = (await gql(pagedQuery(field), { ...range, after }))[field];
      conn.nodes.forEach((n) => add(n.occurredAt));
      after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (after);
  }
}

const today = jstDay(now.toISOString());
const prev = (d) => new Date(Date.parse(d) - 86400000).toISOString().slice(0, 10);
const sorted = [...days.keys()].sort();

// 現在の連続: 今日まだ草がなければ昨日から数える
let cur = 0;
for (let d = days.has(today) ? today : prev(today); days.has(d); d = prev(d)) cur++;

let longest = 0, run = 0, last = null;
for (const d of sorted) {
  run = last && prev(d) === last ? run + 1 : 1;
  longest = Math.max(longest, run);
  last = d;
}
const total = [...days.values()].reduce((a, b) => a + b, 0);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="495" height="150" viewBox="0 0 495 150" role="img" aria-label="JST streak">
  <style>text{font-family:'Segoe UI',Ubuntu,sans-serif;fill:#58a6ff}.n{font-size:32px;font-weight:700}.l{font-size:13px;fill:#8b949e}.t{font-size:11px;fill:#8b949e}</style>
  <rect x="0.5" y="0.5" width="494" height="149" rx="10" fill="#0d1117" stroke="#30363d"/>
  <g text-anchor="middle">
    <text class="n" x="82" y="70">${total}</text><text class="l" x="82" y="95">Contributions (1y)</text>
    <text class="n" x="247" y="70">${cur}</text><text class="l" x="247" y="95">Current Streak (days)</text>
    <text class="n" x="412" y="70">${longest}</text><text class="l" x="412" y="95">Longest Streak (1y)</text>
    <text class="t" x="247" y="130">JST (UTC+9) · updated ${today}</text>
  </g>
</svg>
`;
mkdirSync("assets", { recursive: true });
writeFileSync("assets/streak-jst.svg", svg);
console.log({ total, cur, longest, today });
