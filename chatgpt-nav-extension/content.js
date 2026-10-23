(() => {
  "use strict";

  if (window.__CGN_LOADED__) return;
  window.__CGN_LOADED__ = true;

  // ======================== 选择器适配器 ========================
  // ChatGPT DOM 变动时，优先在这里调整选择器，而不是散落到各处
  const SEL = {
    // 新版轮次容器（优先）
    turnNew: '[data-turn-key]',
    // 旧版轮次容器（回退）
    turnLegacy: '[data-testid^="conversation-turn-"]',

    // 新版用户消息气泡
    userNew: '[data-user-message-bubble="true"]',
    // 旧版用户消息
    userLegacy: '[data-message-author-role="user"], [data-testid="user-message"]',

    // 助手消息旧版仍然可用的情况较多
    assistant: '[data-message-author-role="assistant"]',
    // 回答中的 Markdown 标题
    heading: "h1, h2, h3, h4, h5, h6",
    // 滚动容器候选（按优先级尝试）
    scrollRoots: [
      "[data-scroll-root]",
      "[data-conversation-scroll]",
      "main",
    ],
    // 用户消息中用于提取文本的候选节点
    userTextCandidates: [".whitespace-pre-wrap", '[dir="auto"]', ".markdown", "p"],
  };

  const MAX_PROMPT_LENGTH = 120;
  const SCROLL_THROTTLE_MS = 120;

  // ======================== 状态 ========================
  let turns = [];               // 扁平化的轮次数据
  let activeTurnId = null;      // 当前激活的提问 id
  let activeHeadingId = null;   // 当前激活的标题 id
  let expandedTurns = new Set();// 已展开的提问 id
  let observer = null;
  let scrollRoot = null;
  let rafId = null;
  let lastScrollTime = 0;

  // ======================== 工具函数 ========================

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function getPreview(text, max = MAX_PROMPT_LENGTH) {
    const clean = normalizeText(text);
    return clean.length > max ? clean.slice(0, max) + "…" : clean;
  }

  function getElementText(el) {
    return el ? el.innerText || el.textContent || "" : "";
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function uid(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
  }

  // ======================== 数据提取 ========================

  function findTurnElements() {
    // 优先尝试新版
    let nodes = Array.from(document.querySelectorAll(SEL.turnNew));
    if (nodes.length > 0) return nodes.filter(isVisible);

    // 回退到旧版
    nodes = Array.from(document.querySelectorAll(SEL.turnLegacy));
    if (nodes.length > 0) return nodes.filter(isVisible);

    // 最后兜底：直接找用户消息气泡，向上找到合适的容器
    const userBubbles = document.querySelectorAll(SEL.userNew);
    if (userBubbles.length > 0) {
      return Array.from(userBubbles)
        .map((b) => b.closest('[data-turn-key]') || b.parentElement)
        .filter((el) => el && isVisible(el));
    }

    const userLegacy = document.querySelectorAll(SEL.userLegacy);
    return Array.from(userLegacy)
      .map((n) => n.closest("article, section, div") || n)
      .filter(isVisible);
  }

  function extractPromptText(turnEl) {
    // 优先在新版气泡内找
    let userEl = turnEl.querySelector(SEL.userNew);
    if (!userEl) {
      userEl = turnEl.querySelector(SEL.userLegacy);
    }
    if (!userEl && turnEl.matches(SEL.userNew)) {
      userEl = turnEl;
    }
    if (!userEl) return "";

    for (const selector of SEL.userTextCandidates) {
      const candidates = userEl.querySelectorAll(selector);
      for (const candidate of candidates) {
        const text = normalizeText(getElementText(candidate));
        if (text) return text;
      }
    }
    return normalizeText(getElementText(userEl));
  }

  function extractHeadings(assistantEl) {
    if (!assistantEl) return [];
    const raw = Array.from(assistantEl.querySelectorAll(SEL.heading))
      .map((el) => {
        const text = normalizeText(getElementText(el));
        if (!text) return null;
        if (!el.id) el.id = uid("cgn-heading");
        el.classList.add("cgn-scroll-anchor");
        return {
          id: el.id,
          text,
          level: Number(el.tagName.replace("H", "")) || 1,
          element: el,
        };
      })
      .filter(Boolean);

    return buildHeadingTree(raw);
  }

  /**
   * 将扁平标题列表构建为树形结构。
   * 维护一个“路径栈”：新标题层级深于栈顶则作为子节点，否则弹出直到找到父级。
   */
  function buildHeadingTree(flatHeadings) {
    const root = { children: [] };
    const stack = [{ node: root, level: 0 }];

    for (const h of flatHeadings) {
      const item = { ...h, children: [] };

      while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
        stack.pop();
      }

      const parent = stack[stack.length - 1].node;
      parent.children.push(item);
      stack.push({ node: item, level: h.level });
    }

    return root.children;
  }

  function buildTurns() {
    const turnEls = findTurnElements();
    const result = [];

    turnEls.forEach((turnEl, index) => {
      const promptText = extractPromptText(turnEl);
      if (!promptText) return;

      // 找到该轮次对应的助手回答
      let assistantEl = null;
      const assistantInTurn = turnEl.querySelector(SEL.assistant);
      if (assistantInTurn) {
        assistantEl = assistantInTurn;
      } else {
        // 如果 turn 容器只包含用户消息，尝试找下一个 turn 的助手消息
        const next = turnEls[index + 1];
        if (next) assistantEl = next.querySelector(SEL.assistant);
      }

      const headings = extractHeadings(assistantEl);

      result.push({
        id: uid("cgn-turn"),
        index: result.length + 1,
        promptText,
        preview: getPreview(promptText),
        turnElement: turnEl,
        assistantElement: assistantEl,
        headings,
        headingElements: flattenHeadings(headings),
      });
    });

    return result;
  }

  function flattenHeadings(tree, out = []) {
    for (const h of tree) {
      out.push(h);
      if (h.children?.length) flattenHeadings(h.children, out);
    }
    return out;
  }

  // ======================== 渲染 ========================

  function ensureRoot() {
    let root = document.getElementById("cgn-root");
    if (root) return root;

    root = document.createElement("div");
    root.id = "cgn-root";
    root.innerHTML = `
      <div id="cgn-rail"></div>
      <div id="cgn-panel">
        <div id="cgn-list"></div>
      </div>
    `;
    document.body.appendChild(root);
    return root;
  }

  function render() {
    const root = ensureRoot();
    const rail = root.querySelector("#cgn-rail");
    const list = root.querySelector("#cgn-list");

    // ---- 渲染收起状态的短横杠 ----
    rail.innerHTML = "";
    if (turns.length === 0) {
      rail.innerHTML = '<div class="cgn-rail-line"></div>';
    } else {
      const maxRail = 12;
      const step = Math.max(1, Math.ceil(turns.length / maxRail));
      for (let i = 0; i < turns.length; i += step) {
        const line = document.createElement("div");
        line.className = "cgn-rail-line";
        if (turns[i].id === activeTurnId) line.classList.add("cgn-rail-active");
        line.addEventListener("click", (e) => {
          e.stopPropagation();
          scrollToTurn(turns[i]);
        });
        rail.appendChild(line);
      }
    }

    // ---- 渲染展开面板 ----
    list.innerHTML = "";
    if (turns.length === 0) {
      list.innerHTML = '<div class="cgn-empty">当前对话还没有可导航的内容</div>';
      return;
    }

    for (const turn of turns) {
      const turnEl = document.createElement("div");
      turnEl.className = "cgn-turn";

      // 一级：提问头
      const header = document.createElement("div");
      header.className = "cgn-turn-header";
      header.dataset.turnId = turn.id;
      if (turn.id === activeTurnId) header.classList.add("cgn-active");

      const indexEl = document.createElement("span");
      indexEl.className = "cgn-turn-index";
      indexEl.textContent = turn.index;

      const textEl = document.createElement("span");
      textEl.className = "cgn-turn-text";
      textEl.textContent = turn.preview;
      textEl.title = turn.promptText;

      header.append(indexEl, textEl);

      // 有子标题时才显示展开/收起箭头
      const hasHeadings = turn.headings.length > 0;
      if (hasHeadings) {
        const toggle = document.createElement("span");
        toggle.className = "cgn-toggle";
        toggle.textContent = "›";
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleTurnExpanded(turn, wrapper, toggle);
        });
        header.appendChild(toggle);
        turn._toggleEl = toggle;
        turn._wrapperEl = null; // 稍后赋值
      }

      header.addEventListener("click", (e) => {
        if (e.target.closest(".cgn-toggle")) return;
        if (hasHeadings) {
          const wrapper = turnEl.querySelector(".cgn-headings");
          const toggle = turnEl.querySelector(".cgn-toggle");
          if (wrapper && toggle) toggleTurnExpanded(turn, wrapper, toggle);
        } else {
          scrollToTurn(turn);
        }
      });

      turnEl.appendChild(header);

      // 二级：标题树
      if (hasHeadings) {
        const wrapper = document.createElement("div");
        wrapper.className = "cgn-headings";
        renderHeadingTree(turn.headings, wrapper, turn);
        turnEl.appendChild(wrapper);
        turn._wrapperEl = wrapper;
      }

      list.appendChild(turnEl);
    }

    // 恢复已展开状态
    for (const turn of turns) {
      if (expandedTurns.has(turn.id) && turn._wrapperEl && turn._toggleEl) {
        turn._wrapperEl.classList.add("cgn-open");
        turn._toggleEl.classList.add("cgn-open");
      }
    }
  }

  function renderHeadingTree(headings, container, turn) {
    for (const h of headings) {
      const el = document.createElement("div");
      el.className = "cgn-heading";
      el.dataset.level = h.level;
      el.dataset.headingId = h.id;
      el.textContent = h.text;
      el.title = h.text;
      if (h.id === activeHeadingId) el.classList.add("cgn-active");

      el.addEventListener("click", (e) => {
        e.stopPropagation();
        scrollToHeading(h, turn);
      });

      container.appendChild(el);
      if (h.children?.length) {
        renderHeadingTree(h.children, container, turn);
      }
    }
  }

  function toggleTurnExpanded(turn, wrapper, toggle) {
    const isOpen = wrapper.classList.toggle("cgn-open");
    toggle.classList.toggle("cgn-open", isOpen);
    if (isOpen) expandedTurns.add(turn.id);
    else expandedTurns.delete(turn.id);
  }

  // ======================== 跳转与高亮 ========================

  function scrollToTurn(turn) {
    if (!turn.turnElement) return;
    turn.turnElement.scrollIntoView({ behavior: "smooth", block: "start" });
    flash(turn.turnElement);
    setActiveTurn(turn.id);
  }

  function scrollToHeading(heading, turn) {
    if (!heading.element) return;
    heading.element.scrollIntoView({ behavior: "smooth", block: "start" });
    flash(heading.element);
    setActiveHeading(heading.id);
    setActiveTurn(turn.id);

    // 确保父级已展开
    if (turn._wrapperEl && !turn._wrapperEl.classList.contains("cgn-open")) {
      toggleTurnExpanded(turn, turn._wrapperEl, turn._toggleEl);
    }
  }

  function flash(el) {
    el.classList.remove("cgn-flash");
    void el.offsetWidth;
    el.classList.add("cgn-flash");
    setTimeout(() => el.classList.remove("cgn-flash"), 1700);
  }

  function setActiveTurn(turnId) {
    activeTurnId = turnId;
    document.querySelectorAll(".cgn-turn-header").forEach((el) => {
      el.classList.toggle("cgn-active", el.dataset.turnId === turnId);
    });
    // 更新横杠高亮
    document.querySelectorAll(".cgn-rail-line").forEach((el, i) => {
      const turn = turns[i];
      el.classList.toggle("cgn-rail-active", turn?.id === turnId);
    });
  }

  function setActiveHeading(headingId) {
    activeHeadingId = headingId;
    document.querySelectorAll(".cgn-heading").forEach((el) => {
      el.classList.toggle("cgn-active", el.dataset.headingId === headingId);
    });
  }

  // ======================== 滚动同步（Scroll Spy） ========================

  function findScrollRoot() {
    for (const selector of SEL.scrollRoots) {
      const el = document.querySelector(selector);
      if (el && el.scrollHeight > el.clientHeight + 1) return el;
    }
    // 最后兜底：沿 body 向上找可滚动容器
    let node = document.body;
    while (node && node !== document.documentElement) {
      if (node.scrollHeight > node.clientHeight + 1) return node;
      node = node.parentElement;
    }
    return document.documentElement;
  }

  function setupScrollSpy() {
    scrollRoot = findScrollRoot();
    if (!scrollRoot) return;

    scrollRoot.addEventListener(
      "scroll",
      () => {
        const now = Date.now();
        if (now - lastScrollTime < SCROLL_THROTTLE_MS) return;
        lastScrollTime = now;

        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(updateActiveFromScroll);
      },
      { passive: true }
    );
  }

  function updateActiveFromScroll() {
    if (turns.length === 0) return;

    const viewportTop = scrollRoot.getBoundingClientRect().top + 80; // 顶部偏移，避免刚好卡在边缘

    // 收集所有可导航节点：提问 + 标题
    const candidates = [];
    for (const turn of turns) {
      if (turn.turnElement) {
        candidates.push({
          type: "turn",
          id: turn.id,
          top: turn.turnElement.getBoundingClientRect().top,
          turnId: turn.id,
        });
      }
      for (const h of turn.headingElements) {
        if (h.element) {
          candidates.push({
            type: "heading",
            id: h.id,
            top: h.element.getBoundingClientRect().top,
            turnId: turn.id,
          });
        }
      }
    }

    if (candidates.length === 0) return;

    // 找到 top 不大于视口偏移量的最后一个节点（即刚刚滚过的节点）
    let active = candidates[0];
    for (const c of candidates) {
      if (c.top <= viewportTop + 4) {
        active = c;
      } else {
        break;
      }
    }

    if (active.type === "turn") {
      setActiveTurn(active.turnId);
      setActiveHeading(null);
    } else {
      setActiveTurn(active.turnId);
      setActiveHeading(active.id);
      // 确保该标题的父级已展开，使高亮项在面板中可见
      const turn = turns.find((t) => t.id === active.turnId);
      if (turn?._wrapperEl && !turn._wrapperEl.classList.contains("cgn-open")) {
        turn._wrapperEl.classList.add("cgn-open");
        turn._toggleEl?.classList.add("cgn-open");
        expandedTurns.add(turn.id);
      }
    }
  }

  // ======================== 动态更新（MutationObserver） ========================

  function setupObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      // 防抖：ChatGPT 流式输出期间 DOM 变动频繁
      clearTimeout(setupObserver._timer);
      setupObserver._timer = setTimeout(refresh, 400);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  let lastSignature = "";

  function computeSignature(newTurns) {
    return newTurns
      .map(
        (t) =>
          `${t.promptText.length}:${t.headings.map((h) => h.text).join("|")}`
      )
      .join("||");
  }

  function refresh() {
    const newTurns = buildTurns();
    const signature = computeSignature(newTurns);

    // 如果结构没有实质变化，跳过重渲染，避免打断用户交互
    if (signature === lastSignature && newTurns.length === turns.length) {
      // 但轮次元素可能被虚拟化替换，需要更新引用
      turns = newTurns;
      return;
    }

    lastSignature = signature;
    turns = newTurns;
    render();

    // 首次渲染后重新捕获滚动容器（ChatGPT 可能刚完成挂载）
    if (!scrollRoot) setupScrollSpy();
  }

  // ======================== 启动 ========================

  function init() {
    ensureRoot();
    refresh();
    setupObserver();
    setupScrollSpy();

    // 页面路由变化时（ChatGPT 是 SPA）重新初始化
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        expandedTurns.clear();
        activeTurnId = null;
        activeHeadingId = null;
        lastSignature = "";
        scrollRoot = null;
        refresh();
        setupScrollSpy();
      }
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();