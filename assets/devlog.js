/* devlog — 하루 한 장 모션 카드
   페이지 안 <script type="application/json" id="day"> 의 데이터를 읽어서 카드를 그려요.
   kind 가 "bug" 면 증상 → 원인 → 고침 세 장면, "numbers" 면 테스트 숫자가 바뀌는 장면이에요.
   모션 규칙은 ~/.claude/design/design.md §4 (준비 400 · 이동 700 · 도착 300ms) 를 따라요. */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var MOVE = 'cubic-bezier(0.4, 0.14, 0.3, 1)';
  var ARRIVE = 'cubic-bezier(0, 0, 0.38, 0.9)';
  var STOP = { stopped: true };

  // ── 작은 도우미 ──
  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function swap(a, b, cls) {
    var s = h('span', 'swap' + (cls ? ' ' + cls : ''));
    s.appendChild(h('span', 'a', a));
    s.appendChild(h('span', 'b', b));
    return s;
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  // CSS 의 cubic-bezier 와 같은 곡선을 JS 에서 쓰려고 이분 탐색으로 풀어요.
  function bezier(x1, y1, x2, y2) {
    function at(t, p1, p2) { var u = 1 - t; return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t; }
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var lo = 0, hi = 1, t = x;
      for (var i = 0; i < 24; i++) {
        t = (lo + hi) / 2;
        if (at(t, x1, x2) < x) lo = t; else hi = t;
      }
      return at(t, y1, y2);
    };
  }
  var easeMove = bezier(0.4, 0.14, 0.3, 1);

  // 재생 한 번 = run id 하나. 다른 재생이나 건너뛰기가 시작되면 앞의 재생은 다음 await 에서 멈춰요.
  function Player(root, opts) {
    var runId = 0;
    var self = this;

    function cancelAll() {
      root.getAnimations({ subtree: true }).forEach(function (a) { a.cancel(); });
    }
    function guard(id, p) {
      return Promise.resolve(p).then(function (v) {
        if (id !== runId) throw STOP;
        return v;
      });
    }
    // 정지 상태 k 를 바로 적용. smooth 면 CSS 전환은 살려 둬요.
    function commit(k, smooth) {
      if (!smooth) root.classList.add('instant');
      opts.setState(k);
      cancelAll();
      if (!smooth) {
        void root.offsetWidth;
        requestAnimationFrame(function () { root.classList.remove('instant'); });
      }
    }

    self.ctx = function (id) {
      return {
        anim: function (node, kf, o) {
          var a = node.animate(kf, Object.assign({ fill: 'both' }, o));
          return guard(id, a.finished);
        },
        wait: function (ms) {
          return guard(id, new Promise(function (r) { setTimeout(r, ms); }));
        },
        // rAF 진행값. 첫 프레임 시각이 시작보다 앞설 수 있어서 u 를 0..1 로 잘라요.
        tween: function (ms, ease, onFrame) {
          return guard(id, new Promise(function (resolve) {
            var t0 = performance.now();
            function step() {
              if (id !== runId) return resolve();
              var u = Math.max(0, Math.min(1, (performance.now() - t0) / ms));
              onFrame(ease(u));
              if (u < 1) requestAnimationFrame(step); else resolve();
            }
            requestAnimationFrame(step);
          }));
        },
        commit: function (k) { if (id === runId) commit(k, true); },
        all: function (ps) { return guard(id, Promise.all(ps)); }
      };
    };

    self.jump = function (k) {
      runId++;
      commit(k, false);
    };

    self.play = function () {
      var id = ++runId;
      if (reduce) { commit(opts.last, false); return; }
      commit(0, false);
      var c = self.ctx(id);
      var k = 0;
      (function next() {
        if (k >= opts.last) return;
        var scene = opts.scenes[k];
        c.wait(k === 0 ? 400 : opts.hold)
          .then(function () { return scene(c); })
          .then(function () { k++; c.commit(k); next(); })
          .catch(function (e) { if (e !== STOP) throw e; });
      })();
    };
  }

  function autoplayWhenSeen(node, player) {
    if (reduce || !('IntersectionObserver' in window)) { player.jump(player.last); return; }
    var io = new IntersectionObserver(function (es) {
      if (es.some(function (e) { return e.isIntersecting; })) { io.disconnect(); player.play(); }
    }, { threshold: 0.4 });
    io.observe(node);
  }

  function header(card, d) {
    var k = h('p', 'kicker');
    var back = h('a', null, 'devlog');
    back.href = d.home || '../index.html';
    k.appendChild(back);
    k.appendChild(document.createTextNode(' · ' + d.date + (d.project ? ' · ' + d.project : '')));
    card.appendChild(k);
    card.appendChild(h('h1', null, d.title));
  }

  function captionBox(card) {
    var cap = h('div', 'cap');
    cap.setAttribute('aria-live', 'polite');
    var key = h('span', 'key');
    var txt = h('span', 'txt');
    cap.appendChild(key);
    cap.appendChild(txt);
    card.appendChild(cap);
    return { key: key, txt: txt, set: function (k, t) { key.textContent = k; txt.textContent = t; } };
  }

  // ════════ 버그 카드: 증상 → 원인 → 고침 ════════
  function bugCard(card, d) {
    card.classList.add('bug');
    header(card, d);

    var stage = h('figure', 'stage');
    stage.dataset.s = '0';

    var out = h('div', 'panel out');
    out.appendChild(h('div', 'ph', d.outputLabel || '출력'));
    var ol = h('ol', 'lines');
    var badLi = null, badName = null, badSt = null;
    d.output.forEach(function (ln) {
      var li = h('li');
      if (ln.st) {
        if (ln.bad && ln.fixed) {
          badSt = swap(ln.st, ln.fixed, 'st');
          badSt.firstChild.classList.add(/fail/i.test(ln.st) ? 'fail' : 'pass');
          badSt.lastChild.classList.add(/fail/i.test(ln.fixed) ? 'fail' : 'pass');
          li.appendChild(badSt);
        } else {
          li.appendChild(h('span', 'st ' + (/fail/i.test(ln.st) ? 'fail' : 'pass'), ln.st));
        }
      }
      var nm = h('span', 'nm', ln.text);
      li.appendChild(nm);
      if (ln.bad) { li.classList.add('bad'); badLi = li; badName = nm; }
      ol.appendChild(li);
    });
    out.appendChild(ol);
    var tally = null;
    if (d.tally) {
      var tl = h('div', 'tally');
      tally = swap(d.tally.before, d.tally.after);
      tl.appendChild(tally);
      out.appendChild(tl);
    }

    var code = h('div', 'panel code');
    code.appendChild(h('div', 'ph', d.codeLabel || '코드'));
    var loc = h('div', 'loc', d.location);
    var rule = h('div', 'rule');
    var ruleSwap = swap(d.before, d.after);
    rule.appendChild(ruleSwap);
    code.appendChild(loc);
    code.appendChild(rule);

    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'wire');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(svgNS, 'path');
    svg.appendChild(path);

    var token = h('span', 'token', d.token || (badName && badName.textContent) || '');
    token.setAttribute('aria-hidden', 'true');

    stage.appendChild(out);
    stage.appendChild(code);
    stage.appendChild(svg);
    stage.appendChild(token);
    card.appendChild(stage);

    var cap = captionBox(card);
    var names = ['', '증상', '원인', '고침'];
    var texts = ['', d.captions.symptom, d.captions.cause, d.captions.fix];

    var ctl = h('div', 'ctl');
    var replay = h('button', 'btn', '다시 보기');
    replay.type = 'button';
    var dots = h('ol', 'dots');
    var dotBtns = [1, 2, 3].map(function (k) {
      var li = h('li');
      var b = h('button', null, names[k]);
      b.type = 'button';
      li.appendChild(b);
      dots.appendChild(li);
      return b;
    });
    ctl.appendChild(replay);
    ctl.appendChild(dots);
    card.appendChild(ctl);
    if (d.footnote) card.appendChild(h('p', 'note', d.footnote));

    // 선 경로: 넓을 때는 두 패널 사이로, 좁아서 위아래로 쌓이면 오른쪽 여백으로 돌아가요 (상자를 뚫지 않게).
    function rel(r, s) { return { l: r.left - s.left - stage.clientLeft, r: r.right - s.left - stage.clientLeft, t: r.top - s.top - stage.clientTop, b: r.bottom - s.top - stage.clientTop }; }
    function layoutWire() {
      var s = stage.getBoundingClientRect();
      var o = rel(out.getBoundingClientRect(), s);
      var c = rel(code.getBoundingClientRect(), s);
      var li = rel(badLi.getBoundingClientRect(), s);
      var ru = rel(rule.getBoundingClientRect(), s);
      var sy = (li.t + li.b) / 2, ey = (ru.t + ru.b) / 2;
      var dd;
      if (c.l >= o.r) {
        var sx = o.r, ex = c.l, mx = (sx + ex) / 2;
        dd = 'M' + sx + ' ' + sy + ' C' + mx + ' ' + sy + ' ' + mx + ' ' + ey + ' ' + ex + ' ' + ey;
      } else {
        var bx = Math.max(o.r, c.r) + 28;
        dd = 'M' + o.r + ' ' + sy + ' C' + bx + ' ' + sy + ' ' + bx + ' ' + ey + ' ' + c.r + ' ' + ey;
      }
      path.setAttribute('d', dd);
      var len = path.getTotalLength();
      path.style.setProperty('--len', len);
      return len;
    }
    function placeToken(x, y) {
      token.style.transform = 'translate(' + (x - token.offsetWidth / 2) + 'px,' + (y - token.offsetHeight / 2) + 'px)';
    }

    function setState(k) {
      stage.dataset.s = String(k);
      cap.set(names[k] || '', texts[k] || '');
      dotBtns.forEach(function (b, i) {
        if (i + 1 === k) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      });
      var fixed = k >= 3;
      ruleSwap.classList.toggle('on', fixed);
      if (badSt) badSt.classList.toggle('on', fixed);
      if (tally) tally.classList.toggle('on', fixed);
      token.classList.toggle('back', false);
      token.style.opacity = '';
      path.style.strokeDashoffset = '';
      if (k >= 2) layoutWire(); else { path.removeAttribute('d'); path.style.setProperty('--len', 0); }
    }

    function capIn(c, k) {
      cap.set(names[k], texts[k]);
      dotBtns.forEach(function (b, i) {
        if (i + 1 === k) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      });
      return c.anim(cap.txt, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: ARRIVE });
    }

    var scenes = [
      // 1 증상: 출력 줄이 한 줄씩 지워지듯 나타나고, 문제 줄이 빨갛게 바뀌어요.
      function (c) {
        capIn(c, 1);
        var ps = Array.prototype.map.call(ol.children, function (li, i) {
          return c.anim(li, [{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }, { opacity: 1, clipPath: 'inset(0 0 0 0)' }], { duration: 300, delay: i * 90, easing: ARRIVE });
        });
        if (tally) ps.push(c.anim(tally.parentNode, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: ol.children.length * 90 + 100 }));
        return c.all(ps).then(function () {
          c.commit(1); // 문제 줄 배경은 CSS 전환으로 300ms
          return c.wait(320);
        });
      },
      // 2 원인: 문제 줄의 이름표가 떨어져 나와 선을 따라 코드 자리로 가요.
      function (c) {
        capIn(c, 2);
        var len = layoutWire();
        var p0 = path.getPointAtLength(0);
        var s = stage.getBoundingClientRect();
        var nr = badName.getBoundingClientRect();
        var nx = nr.left - s.left - stage.clientLeft + Math.min(nr.width, token.offsetWidth) / 2;
        var ny = (nr.top + nr.bottom) / 2 - s.top - stage.clientTop;
        placeToken(nx, ny);
        // 준비 400ms: 줄 안의 이름 자리에서 떠올라 선 시작점으로
        return c.tween(400, easeMove, function (u) {
          token.style.opacity = String(Math.min(1, u * 3));
          placeToken(nx + (p0.x - nx) * u, ny + (p0.y - ny) * u - 4 * Math.sin(Math.PI * u));
        }).then(function () {
          // 이동 700ms: 선이 뒤따라 그려져요
          return c.tween(700, easeMove, function (u) {
            var p = path.getPointAtLength(len * u);
            placeToken(p.x, p.y);
            path.style.strokeDashoffset = String(len * (1 - u));
          });
        }).then(function () {
          // 도착 300ms: 이름표가 스며들고 코드 자리가 나타나요
          return c.all([
            c.anim(token, [{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: ARRIVE }),
            c.anim(loc, [{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }, { opacity: 1, clipPath: 'inset(0 0 0 0)' }], { duration: 300, easing: ARRIVE }),
            c.anim(rule, [{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }, { opacity: 1, clipPath: 'inset(0 0 0 0)' }], { duration: 300, delay: 80, easing: ARRIVE })
          ]);
        }).then(function () {
          path.style.strokeDashoffset = '';
          c.commit(2);
          return c.wait(320);
        });
      },
      // 3 고침: 코드 자리의 규칙이 바뀌고, 같은 이름표가 초록으로 돌아가 결과를 바꿔요.
      function (c) {
        capIn(c, 3);
        var len = layoutWire();
        path.style.strokeDashoffset = '0';
        return c.all([
          c.anim(ruleSwap.firstChild, [{ transform: 'none', opacity: 1 }, { transform: 'translateY(-100%)', opacity: 0 }], { duration: 400, easing: MOVE }),
          c.anim(ruleSwap.lastChild, [{ transform: 'translateY(100%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 400, easing: MOVE })
        ]).then(function () {
          token.classList.add('back');
          var err = cssVar('--err'), ok = cssVar('--ok');
          return c.all([
            c.anim(path, [{ stroke: err }, { stroke: ok }], { duration: 700, easing: MOVE }),
            c.tween(700, easeMove, function (u) {
              var p = path.getPointAtLength(len * (1 - u));
              token.style.opacity = String(u < 0.15 ? u / 0.15 : u > 0.85 ? (1 - u) / 0.15 : 1);
              placeToken(p.x, p.y);
            })
          ]);
        }).then(function () {
          path.style.strokeDashoffset = '';
          c.commit(3); // 줄 상태·결과 줄 바꿔치기와 초록 테두리는 CSS 전환
          return c.wait(420);
        });
      }
    ];

    var player = new Player(card, { setState: setState, scenes: scenes, last: 3, hold: d.hold || 2600 });
    player.last = 3;
    replay.addEventListener('click', function () { player.play(); });
    dotBtns.forEach(function (b, i) { b.addEventListener('click', function () { player.jump(i + 1); }); });
    window.addEventListener('resize', function () { if (+stage.dataset.s >= 2) layoutWire(); });
    setState(0);
    autoplayWhenSeen(stage, player);
  }

  // ════════ 숫자 카드: 테스트 결과가 단계마다 바뀌어요 ════════
  function numbersCard(card, d) {
    card.classList.add('num');
    header(card, d);
    var total = d.tests.length;

    var stage = h('figure', 'stage');
    var left = h('div');
    var count = h('div', 'count');
    var big = h('span', 'big', '0');
    count.appendChild(big);
    count.appendChild(h('span', 'of', '/ ' + total + ' ' + (d.unit || 'PASS')));
    left.appendChild(count);

    var cellsBox = h('div', 'cells');
    var cells = {};
    d.tests.forEach(function (name) {
      var c = h('div', 'cell');
      c.title = name;
      c.appendChild(h('span', 'fill'));
      cellsBox.appendChild(c);
      cells[name] = c;
    });
    left.appendChild(cellsBox);
    if (d.groups) {
      var g = h('div', 'group');
      d.groups.forEach(function (t) { g.appendChild(h('span', null, t)); });
      left.appendChild(g);
    }
    var fails = h('div', 'fails');
    var chips = {};
    d.steps.forEach(function (st) {
      st.fail.forEach(function (n) {
        if (chips[n]) return;
        var ch = h('span', 'chip', n);
        ch.hidden = true;
        fails.appendChild(ch);
        chips[n] = ch;
      });
    });
    left.appendChild(fails);

    var rail = h('ol', 'rail');
    var marker = h('span', 'marker');
    marker.setAttribute('aria-hidden', 'true');
    var railItems = d.steps.map(function (st, i) {
      var li = h('li');
      var b = h('button');
      b.type = 'button';
      b.appendChild(h('span', 'dot'));
      var txt = h('span');
      txt.appendChild(h('span', 'lb', st.label));
      txt.appendChild(h('span', 'ct', (total - st.fail.length) + ' / ' + total));
      b.appendChild(txt);
      li.appendChild(b);
      rail.appendChild(li);
      return li;
    });
    rail.appendChild(marker);

    stage.appendChild(left);
    stage.appendChild(rail);
    card.appendChild(stage);
    var cap = captionBox(card);

    var ctl = h('div', 'ctl');
    var replay = h('button', 'btn', '다시 보기');
    replay.type = 'button';
    ctl.appendChild(replay);
    card.appendChild(ctl);
    if (d.footnote) card.appendChild(h('p', 'note', d.footnote));

    var last = d.steps.length;
    function passOf(k) { return k === 0 ? 0 : total - d.steps[k - 1].fail.length; }
    function stateOf(k, name) {
      if (k === 0) return '';
      return d.steps[k - 1].fail.indexOf(name) >= 0 ? 'fail' : 'pass';
    }
    function dotY(k) {
      var li = railItems[k - 1];
      return li.offsetTop;
    }
    function setState(k) {
      big.textContent = String(passOf(k));
      d.tests.forEach(function (n) { cells[n].className = 'cell ' + stateOf(k, n); });
      Object.keys(chips).forEach(function (n) { chips[n].hidden = !(k > 0 && d.steps[k - 1].fail.indexOf(n) >= 0); });
      railItems.forEach(function (li, i) {
        li.classList.toggle('done', i + 1 < k);
        li.classList.toggle('cur', i + 1 === k);
      });
      if (k > 0) {
        marker.style.opacity = '1';
        marker.style.transform = 'translateY(' + dotY(k) + 'px)';
        cap.set(k + ' / ' + last, d.steps[k - 1].note || '');
      } else {
        marker.style.opacity = '0';
        cap.set('', '');
      }
    }

    function scene(k) {
      return function (c) {
        var prev = k - 1;
        cap.set(k + ' / ' + last, d.steps[k - 1].note || '');
        var ps = [c.anim(cap.txt, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: ARRIVE })];
        // 레일 표시가 다음 점으로 이동
        if (prev === 0) {
          marker.style.transform = 'translateY(' + dotY(k) + 'px)';
          ps.push(c.anim(marker, [{ opacity: 0 }, { opacity: 1 }], { duration: 250, easing: ARRIVE }));
        } else {
          ps.push(c.anim(marker, [{ transform: 'translateY(' + dotY(prev) + 'px)' }, { transform: 'translateY(' + dotY(k) + 'px)' }], { duration: 500, easing: MOVE }));
        }
        return c.all(ps).then(function () {
          // 바뀐 칸만 새 색으로 왼쪽부터 채워져요
          var changed = d.tests.filter(function (n) { return stateOf(prev, n) !== stateOf(k, n); });
          var anims = changed.map(function (n, i) {
            cells[n].className = 'cell ' + stateOf(k, n);
            return c.anim(cells[n].firstChild, [{ transform: 'scaleX(0)' }, { transform: 'none' }], { duration: 300, delay: i * 25, easing: MOVE });
          });
          // 빠지는 실패 이름표는 오른쪽부터 지워지고, 새 이름표는 왼쪽부터 나타나요
          Object.keys(chips).forEach(function (n) {
            var was = prev > 0 && d.steps[prev - 1].fail.indexOf(n) >= 0;
            var now = d.steps[k - 1].fail.indexOf(n) >= 0;
            if (was && !now) anims.push(c.anim(chips[n], [{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(0 100% 0 0)' }], { duration: 250, easing: MOVE }));
            if (!was && now) {
              chips[n].hidden = false;
              anims.push(c.anim(chips[n], [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 300, delay: 200, easing: ARRIVE }));
            }
          });
          var a = passOf(prev), b = passOf(k);
          anims.push(c.tween(600, easeMove, function (u) { big.textContent = String(Math.round(a + (b - a) * u)); }));
          return c.all(anims);
        });
      };
    }
    var scenes = d.steps.map(function (_, i) { return scene(i + 1); });

    var player = new Player(card, { setState: setState, scenes: scenes, last: last, hold: d.hold || 2400 });
    player.last = last;
    replay.addEventListener('click', function () { player.play(); });
    railItems.forEach(function (li, i) { li.firstChild.addEventListener('click', function () { player.jump(i + 1); }); });
    setState(0);
    autoplayWhenSeen(stage, player);
  }

  // ════════ 목록 ════════
  function listPage(card, days) {
    var ul = h('ul', 'days');
    days.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).forEach(function (x) {
      var li = h('li');
      var a = h('a');
      a.href = x.href;
      a.appendChild(h('span', 'd', x.date));
      a.appendChild(h('span', 'k', x.kind === 'bug' ? '버그' : '숫자'));
      a.appendChild(h('span', 't', x.title));
      li.appendChild(a);
      ul.appendChild(li);
    });
    card.appendChild(ul);
  }

  var card = document.getElementById('card');
  if (!card) return;
  if (window.DEVLOG_DAYS && card.dataset.list != null) { listPage(card, window.DEVLOG_DAYS); return; }
  var src = document.getElementById('day');
  if (!src) return;
  var d = JSON.parse(src.textContent);
  if (d.kind === 'bug') bugCard(card, d);
  else if (d.kind === 'numbers') numbersCard(card, d);
})();
