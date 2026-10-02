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
    id
    contributionsCollection(from: $from, to: $to) {
      commitContributionsByRepository(maxRepositories: 100) {
        repository { name owner { login } }
      }
    }
  }
}`;

// 集計ノードは UTC 日単位なので、JST で数えるためコミット個別の時刻を取得する
const historyQuery = `
query($owner: String!, $name: String!, $since: GitTimestamp!, $until: GitTimestamp!, $author: ID!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100, since: $since, until: $until, author: { id: $author }, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { committedDate }
          }
        }
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
  return json.data;
}

const days = new Map();
const add = (iso, n = 1) => days.set(jstDay(iso), (days.get(jstDay(iso)) ?? 0) + n);

// 直近 1 年を 2 週間ごとに取得（リポジトリ数の 100 件上限を避けるため窓を細かくする）
const now = new Date();
const WINDOW = 14 * 86400000;
for (let i = 0; i < 27; i++) {
  const to = new Date(now.getTime() - i * WINDOW);
  const from = new Date(to.getTime() - WINDOW);
  const range = { login: user, from: from.toISOString(), to: to.toISOString() };

  const { user: u } = await gql(commitQuery, range);
  for (const { repository } of u.contributionsCollection.commitContributionsByRepository) {
    let after = null;
    do {
      const data = await gql(historyQuery, {
        owner: repository.owner.login, name: repository.name,
        since: range.from, until: range.to, author: u.id, after,
      });
      const h = data.repository?.defaultBranchRef?.target?.history;
      if (!h) break;
      h.nodes.forEach((n) => add(n.committedDate));
      after = h.pageInfo.hasNextPage ? h.pageInfo.endCursor : null;
    } while (after);
  }

  for (const field of ["pullRequestContributions", "pullRequestReviewContributions", "issueContributions"]) {
    let after = null;
    do {
      const conn = (await gql(pagedQuery(field), { ...range, after })).user.contributionsCollection[field];
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

// 直近 30 日（JST）のアクティビティグラフ
{
  const N = 30, W = 495, H = 195, L = 36, R = 15, T = 40, B = 30;
  const series = [];
  for (let d = today, i = 0; i < N; d = prev(d), i++) series.unshift([d, days.get(d) ?? 0]);
  const max = Math.max(5, ...series.map(([, v]) => v));
  const x = (i) => L + ((W - L - R) * i) / (N - 1);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const pts = series.map(([, v], i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = `${x(0)},${y(0)} ${pts.join(" ")} ${x(N - 1)},${y(0)}`;
  const grid = [0, 0.5, 1].map((r) => {
    const v = Math.round(max * r);
    return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#21262d"/><text class="t" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }).join("");
  const ticks = [0, 7, 14, 21, 29].map((i) =>
    `<text class="t" x="${x(i)}" y="${H - 10}" text-anchor="middle">${series[i][0].slice(5)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Activity graph (JST)">
  <style>text{font-family:'Segoe UI',Ubuntu,sans-serif}.t{font-size:10px;fill:#8b949e}.h{font-size:14px;fill:#58a6ff;font-weight:600}</style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="#0d1117" stroke="#30363d"/>
  <text class="h" x="${W / 2}" y="26" text-anchor="middle">${user}'s GitHub Activity (last 30 days, JST)</text>
  ${grid}
  <polygon points="${area}" fill="#58a6ff" fill-opacity="0.2"/>
  <polyline points="${pts.join(" ")}" fill="none" stroke="#58a6ff" stroke-width="2"/>
  ${series.map(([, v], i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="#58a6ff"/>`).join("")}
  ${ticks}
</svg>
`;
  writeFileSync("assets/activity-graph-jst.svg", svg);
}
