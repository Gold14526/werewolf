// Static statement rebuilt from the user-provided P4899 reference.
// Original site scripts, account data, links, and runtime attributes are excluded.

export const PROBLEM_TITLE = "P4899 [IOI 2018] werewolf 狼人";

export const PROBLEM_DOCUMENT_TITLE = "P4899 [IOI 2018] werewolf 狼人 - 洛谷";

export const PROBLEM_SECTIONS = [
  {
    "id": "description",
    "title": "题目描述",
    "html": "<p>在日本的茨城县内共有 <span class=\"math-inline\">N</span> 个城市和 <span class=\"math-inline\">M</span> 条道路。这些城市是根据人口数量的升序排列的，依次编号为 <span class=\"math-inline\">0</span> 到 <span class=\"math-inline\">N−1</span>。每条道路连接两个不同的城市，并且可以双向通行。由这些道路，你能从任意一个城市到另外任意一个城市。</p>\n<p>你计划了 <span class=\"math-inline\">Q</span> 个行程，这些行程分别编号为 <span class=\"math-inline\">0</span> 至 <span class=\"math-inline\">Q−1</span>。第 <span class=\"math-inline\">i(0≤i≤Q−1)</span> 个行程是从城市 <span class=\"math-inline\">S<sub>i</sub></span> 到城市 <span class=\"math-inline\">E<sub>i</sub></span>。</p>\n<p>你是一个狼人。你有两种形态：<strong>人形</strong>和<strong>狼形</strong>。在每个行程开始的时候，你是人形。在每个行程结束的时候，你必须是狼形。在行程中，你必须要变身（从人形变成狼形）恰好一次，而且只能在某个城市内（包括可能是在 <span class=\"math-inline\">S<sub>i</sub></span> 或 <span class=\"math-inline\">E<sub>i</sub></span> 内）变身。</p>\n<p>狼人的生活并不容易。当你是人形时，你必须避开人少的城市，而当你是狼形时，你必须避开人多的城市。对于每一次行程 <span class=\"math-inline\">i(0≤i≤Q−1)</span>，都有两个阈值 <span class=\"math-inline\">L<sub>i</sub></span> 和 <span class=\"math-inline\">R<sub>i</sub>(0≤L<sub>i</sub>≤R<sub>i</sub>≤N−1)</span>，用以表示哪些城市必须要避开。准确地说，当你是人形时，你必须避开城市 <span class=\"math-inline\">0,1,…,L<sub>i</sub>−1</span> ；而当你是狼形时，则必须避开城市 <span class=\"math-inline\">R<sub>i</sub>+1,R<sub>i</sub>+2,…,N−1</span>。这就是说，在行程 <span class=\"math-inline\">i</span> 中，你必须在城市 <span class=\"math-inline\">L<sub>i</sub>,L<sub>i</sub>+1,…,R<sub>i</sub></span> 中的其中一个城市内变身。</p>\n<p>你的任务是，对每一次行程，判定是否有可能在满足上述限制的前提下，由城市 <span class=\"math-inline\">S<sub>i</sub></span> 走到城市 <span class=\"math-inline\">E<sub>i</sub></span>。你的路线可以有任意长度。</p>"
  },
  {
    "id": "input",
    "title": "输入格式",
    "html": "<p>输入的第一行包含三个正整数 <span class=\"math-inline\">N,M,Q</span>，其意义见题目描述。</p>\n<p>接下来 <span class=\"math-inline\">M</span> 行，每行包含两个非负整数。在这 <span class=\"math-inline\">M</span> 行中，第 <span class=\"math-inline\">j</span> 行的两个非负整数分别表示 <span class=\"math-inline\">X<sub>j−1</sub>,Y<sub>j−1</sub></span>，即编号为 <span class=\"math-inline\">j−1</span> 的道路连接的两个城市的编号。</p>\n<p>接下来 <span class=\"math-inline\">Q</span> 行，每行包含四个非负整数。在这 <span class=\"math-inline\">Q</span> 行中，第 <span class=\"math-inline\">i</span> 行的四个非负整数分别表示 <span class=\"math-inline\">S<sub>i−1</sub>,E<sub>i−1</sub>,L<sub>i−1</sub>,R<sub>i−1</sub></span>，即编号为 <span class=\"math-inline\">i−1</span> 的行程的起点城市编号、终点城市编号以及两个阈值。</p>"
  },
  {
    "id": "output",
    "title": "输出格式",
    "html": "<p>输出包含 <span class=\"math-inline\">Q</span> 行，每行包含一个非 <span class=\"math-inline\">0</span> 即 <span class=\"math-inline\">1</span> 的整数。第 <span class=\"math-inline\">i</span> 行的整数表示对于编号为 <span class=\"math-inline\">i−1</span> 的行程，是否能从城市 <span class=\"math-inline\">S<sub>i−1</sub></span> 走至城市 <span class=\"math-inline\">E<sub>i−1</sub></span>，若能够，那么输出整数为 <span class=\"math-inline\">1</span>；若不能，那么输出整数为 <span class=\"math-inline\">0</span>。</p>"
  },
  {
    "id": "samples",
    "title": "输入输出样例",
    "html": "<div class=\"problem-sample\"><div class=\"problem-sample-block\"><p class=\"problem-sample-label\">输入 #1</p><pre><code>6 6 3\n5 1\n1 2\n1 3\n3 4\n3 0\n5 2\n4 2 1 2\n4 2 2 2\n5 4 3 4\n</code></pre></div><div class=\"problem-sample-block\"><p class=\"problem-sample-label\">输出 #1</p><pre><code>1\n0\n0\n</code></pre></div></div><div class=\"problem-sample\"><div class=\"problem-sample-block\"><p class=\"problem-sample-label\">输入 #2</p><pre><code>10 9 10\n6 7\n1 5\n8 0\n2 9\n9 4\n2 7\n8 5\n6 0\n3 4\n4 9 0 9\n8 1 8 9\n1 8 1 8\n8 3 5 5\n8 9 3 9\n0 1 0 2\n9 0 6 6\n1 7 1 8\n9 4 5 6\n9 5 0 9\n</code></pre></div><div class=\"problem-sample-block\"><p class=\"problem-sample-label\">输出 #2</p><pre><code>1\n1\n1\n0\n1\n1\n0\n1\n0\n1\n</code></pre></div></div>"
  },
  {
    "id": "notes",
    "title": "说明/提示",
    "html": "<p><strong>限制条件</strong></p>\n<ul>\n<li><span class=\"math-inline\">2≤N≤200,000</span></li>\n<li><span class=\"math-inline\">N−1≤M≤400,000</span></li>\n<li><span class=\"math-inline\">1≤Q≤200,000</span></li>\n<li>对于每个 <span class=\"math-inline\">0≤j≤M−1</span>\n<ul>\n<li><span class=\"math-inline\">0≤X<sub>j</sub>≤N−1</span></li>\n<li><span class=\"math-inline\">0≤Y<sub>j</sub>≤N−1</span></li>\n<li><span class=\"math-inline\">X<sub>j</sub>≠Y<sub>j</sub></span></li>\n</ul>\n</li>\n<li>你可以通过道路由任意一个城市去另外任意一个城市。</li>\n<li>每一对城市最多只由一条道路直接连起来。换言之，对于所有 <span class=\"math-inline\">0≤j&lt;k≤M−1</span>，都有 <span class=\"math-inline\">(X<sub>j</sub>,Y<sub>j</sub>)≠(X<sub>k</sub>,Y<sub>k</sub>)</span> 和 <span class=\"math-inline\">(Y<sub>j</sub>,X<sub>j</sub>)≠(X<sub>k</sub>,Y<sub>k</sub>)</span></li>\n<li>对于每个 <span class=\"math-inline\">0≤i≤Q−1</span>\n<ul>\n<li><span class=\"math-inline\">0≤L<sub>i</sub>≤S<sub>i</sub>≤N−1</span></li>\n<li><span class=\"math-inline\">0≤E<sub>i</sub>≤R<sub>i</sub>≤N−1</span></li>\n<li><span class=\"math-inline\">S<sub>i</sub>≠E<sub>i</sub></span></li>\n<li><span class=\"math-inline\">L<sub>i</sub>≤R<sub>i</sub></span></li>\n</ul>\n</li>\n</ul>\n<p><strong>子任务</strong></p>\n<ul>\n<li>1.（7 分）<span class=\"math-inline\">N≤100</span>，<span class=\"math-inline\">M≤200</span>，<span class=\"math-inline\">Q≤100</span>。</li>\n<li>2.（8 分）<span class=\"math-inline\">N≤3,000</span>，<span class=\"math-inline\">M≤6,000</span>，<span class=\"math-inline\">Q≤3,000</span>。</li>\n<li>3.（34 分）<span class=\"math-inline\">M=N−1</span> 且每个城市最多与两条路相连（所有城市是以一条直线的形式连起来）。</li>\n<li>4.（51 分）没有附加限制。</li>\n</ul>"
  }
];

export const PROBLEM_SAMPLES = [
  {
    "input": "6 6 3\n5 1\n1 2\n1 3\n3 4\n3 0\n5 2\n4 2 1 2\n4 2 2 2\n5 4 3 4\n",
    "output": "1\n0\n0\n"
  },
  {
    "input": "10 9 10\n6 7\n1 5\n8 0\n2 9\n9 4\n2 7\n8 5\n6 0\n3 4\n4 9 0 9\n8 1 8 9\n1 8 1 8\n8 3 5 5\n8 9 3 9\n0 1 0 2\n9 0 6 6\n1 7 1 8\n9 4 5 6\n9 5 0 9\n",
    "output": "1\n1\n1\n0\n1\n1\n0\n1\n0\n1\n"
  }
];

export const PROBLEM_CONTENT_HTML = PROBLEM_SECTIONS.map(({ id, title, html }) =>
  `<section class="problem-section" id="problem-${id}"><h2>${title}</h2>${html}</section>`
).join("\n");
