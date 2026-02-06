(() => {
  const STATE_URL = "/api/onboarding/state";
  const ACTION_URL = "/api/onboarding/action";
  const ONBOARDING_ACTIVE_KEY = "vs_onboarding_active";
  const MOUNT_ID = "onboardingGuideMount";
  const SPRITE_ID = "onboardingSprite";
  const TOOLTIP_ID = "onboardingTooltip";

  let inflight = false;
  let cache = null;
  let positionRaf = 0;
  let pendingTimer = 0;

  const q = (sel, root = document) => root.querySelector(sel);
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const escapeHtml = (s) =>
    String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const currentPath = () => {
    try {
      return String(window.location.pathname || "/");
    } catch {
      return "/";
    }
  };
  const toPath = (href) => {
    try {
      return String(new URL(String(href || ""), window.location.origin).pathname || "/");
    } catch {
      return "";
    }
  };
  const setPendingGate = (on) => {
    document.documentElement.classList.toggle("onboarding-pending", !!on);
  };
  const markOnboardingActiveHint = (active) => {
    try {
      if (active) {
        window.sessionStorage.setItem(ONBOARDING_ACTIVE_KEY, "1");
      } else {
        window.sessionStorage.removeItem(ONBOARDING_ACTIVE_KEY);
      }
    } catch {}
  };
  const beginPendingNavigation = () => {
    if (pendingTimer) {
      window.clearTimeout(pendingTimer);
      pendingTimer = 0;
    }
    markOnboardingActiveHint(true);
    setPendingGate(true);
    pendingTimer = window.setTimeout(() => {
      pendingTimer = 0;
      setPendingGate(false);
    }, 6000);
  };

  const htmxNavigate = (href, opts = {}) => {
    const url = String(href || "").trim();
    if (!url) return false;
    const pushURL = opts && Object.prototype.hasOwnProperty.call(opts, "pushURL") ? !!opts.pushURL : true;
    if (window.htmx && typeof window.htmx.ajax === "function") {
      beginPendingNavigation();
      window.htmx.ajax("GET", url, {
        target: "#content",
        swap: "outerHTML",
        select: "#content",
        pushURL,
      });
      return true;
    }
    beginPendingNavigation();
    window.location.href = url;
    return true;
  };

  const ensureMount = () => {
    const container = q("#content .container");
    if (!container) return null;
    let mount = q(`#${MOUNT_ID}`, container);
    if (mount) return mount;

    mount = document.createElement("div");
    mount.id = MOUNT_ID;
    mount.className = "onboarding-guide-mount";

    const h1 = q("h1", container);
    if (h1 && h1.parentNode) h1.insertAdjacentElement("afterend", mount);
    else container.prepend(mount);
    return mount;
  };

  const ensureSprite = () => {
    let sprite = q(`#${SPRITE_ID}`);
    if (!sprite) {
      sprite = document.createElement("div");
      sprite.id = SPRITE_ID;
      sprite.className = "onboarding-sprite hidden";
      sprite.innerHTML = '<span class="onboarding-sprite-dot" aria-hidden="true"></span>';
      document.body.appendChild(sprite);
    }

    let tooltip = q(`#${TOOLTIP_ID}`);
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = TOOLTIP_ID;
      tooltip.className = "onboarding-tooltip hidden";
      tooltip.setAttribute("aria-live", "polite");
      document.body.appendChild(tooltip);
    }
    return { sprite, tooltip };
  };

  const hideSprite = () => {
    const { sprite, tooltip } = ensureSprite();
    sprite.classList.add("hidden");
    tooltip.classList.add("hidden");
    tooltip.innerHTML = "";
  };

  const setScreenMode = (mode) => {
    const isScreen = mode === "screen";
    const isFocus = mode === "focus";
    document.body.classList.toggle("onboarding-screen-active", isScreen);
    document.body.classList.toggle("onboarding-focus-active", isFocus);
  };
  const setParentGenerateCompact = (on) => {
    document.body.classList.toggle("onboarding-hide-parent-generate-btn", !!on);
  };

  const clearFocusScope = () => {
    document.querySelectorAll("[data-onboarding-focus-root]").forEach((n) => {
      n.removeAttribute("data-onboarding-focus-root");
      n.removeAttribute("data-onboarding-focus-has-child");
    });
    document.querySelectorAll("[data-onboarding-focus-current]").forEach((n) => {
      n.removeAttribute("data-onboarding-focus-current");
    });
  };

  const findTarget = (step) => {
    if (!step) return null;
    const sel = String(step.target_selector || "").trim();
    if (!sel) return null;
    try {
      return q(sel);
    } catch {
      return null;
    }
  };

  const focusCurrentStepScope = (step) => {
    clearFocusScope();
    const container = q("#content .container");
    if (!container || !step) return false;
    const target = findTarget(step);
    if (!target) return false;

    const scopeCandidate =
      target.closest('[data-guide-focus-scope], .card, form, section, article, .actions') || target;

    let root = scopeCandidate;
    while (root && root.parentElement && root.parentElement !== container) {
      root = root.parentElement;
    }
    if (!root || root.parentElement !== container) return false;

    let current = scopeCandidate;
    while (current && current.parentElement && current.parentElement !== root) {
      current = current.parentElement;
    }
    if (!current) return false;

    root.setAttribute("data-onboarding-focus-root", "1");
    if (current !== root) {
      root.setAttribute("data-onboarding-focus-has-child", "1");
      current.setAttribute("data-onboarding-focus-current", "1");
    } else {
      root.setAttribute("data-onboarding-focus-current", "1");
    }
    return true;
  };

  const triggerNode = (node) => {
    if (!(node instanceof Element)) return false;
    if (node instanceof HTMLAnchorElement) {
      const href = String(node.getAttribute("href") || "").trim();
      if (!href) return false;
      return htmxNavigate(href, { pushURL: true });
    }
    if (node instanceof HTMLFormElement) {
      if (typeof node.requestSubmit === "function") node.requestSubmit();
      else node.submit();
      return true;
    }
    if (node instanceof HTMLButtonElement) {
      node.click();
      return true;
    }
    if (node instanceof HTMLInputElement && (node.type === "submit" || node.type === "button")) {
      node.click();
      return true;
    }
    const nested = node.querySelector(
      'button:not([disabled]),a[href],input[type="submit"]:not([disabled]),form'
    );
    if (nested) return triggerNode(nested);
    return false;
  };

  const triggerCurrentStep = () => {
    const step = cache?.current_step;
    if (!step) return;
    const target = findTarget(step);
    if (target && triggerNode(target)) return;
    const href = String(step.href || "").trim();
    if (href) {
      htmxNavigate(href, { pushURL: true });
    }
  };

  const maybeAutoNavigateToCurrentStep = (state, triggerAction) => {
    if (!state || !state.enabled || !state.show) return false;
    const fromRoleOrStage = triggerAction === "choose_stage" || triggerAction === "choose_role";
    if (!fromRoleOrStage) return false;
    if (state.role_selection_required || state.stage_selection_required) return false;
    const step = state.current_step || null;
    if (!step) return false;
    const href = String(step.href || "").trim();
    if (!href) return false;
    const hrefPath = toPath(href);
    if (!hrefPath || hrefPath === currentPath()) return false;
    return htmxNavigate(href, { pushURL: true });
  };

  const placeTooltip = (tooltip, rect, placement) => {
    const vw = window.innerWidth || document.documentElement.clientWidth || 360;
    const vh = window.innerHeight || document.documentElement.clientHeight || 640;
    const tw = tooltip.offsetWidth || 240;
    const th = tooltip.offsetHeight || 70;
    const gap = 10;

    let left = rect.left + rect.width / 2 - tw / 2;
    let top = rect.bottom + gap;

    const p = String(placement || "bottom").toLowerCase();
    if (p === "top") top = rect.top - th - gap;
    if (p === "left") {
      left = rect.left - tw - gap;
      top = rect.top + rect.height / 2 - th / 2;
    }
    if (p === "right") {
      left = rect.right + gap;
      top = rect.top + rect.height / 2 - th / 2;
    }

    left = clamp(left, 8, vw - tw - 8);
    top = clamp(top, 56, vh - th - 8);
    tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };

  const renderSprite = (state) => {
    void state;
    // 2026-02-06: 精简引导，不再显示橙色飞点和左下提示。
    hideSprite();
    return false;
  };

  const renderGuideCard = (state) => {
    const mount = ensureMount();
    if (!mount) return;

    if (!state || !state.enabled || !state.show) {
      mount.innerHTML = "";
      setScreenMode("");
      setParentGenerateCompact(false);
      clearFocusScope();
      hideSprite();
      return;
    }

    if (state.role_selection_required) {
      setScreenMode("screen");
      setParentGenerateCompact(false);
      clearFocusScope();
      mount.innerHTML = `
        <div class="card onboarding-card onboarding-screen-card">
          <button class="onboarding-screen-close" type="button" data-onboarding-action="dismiss" aria-label="退出引导">×</button>
          <div class="card-k">新手引导</div>
          <div class="card-v">先选身份</div>
          <div class="muted">请选择你现在是学生还是家长。</div>
          <div class="actions mt-10">
            <button class="btn primary" type="button" data-onboarding-action="choose_role" data-onboarding-role="self">我是学生</button>
            <button class="btn" type="button" data-onboarding-action="choose_role" data-onboarding-role="parent">我是家长</button>
          </div>
        </div>
      `;
      hideSprite();
      return;
    }

    if (state.stage_selection_required) {
      setScreenMode("screen");
      setParentGenerateCompact(false);
      clearFocusScope();
      const roleLabel = state.flow === "parent" ? "孩子" : "你";
      const options = Array.isArray(state.stage_options) ? state.stage_options : [];
      const optionHtml = options
        .map((it) => {
          const value = escapeHtml(it?.value || "");
          const label = escapeHtml(it?.label || value);
          return `<button class="btn" type="button" data-onboarding-action="choose_stage" data-onboarding-stage="${value}">${label}</button>`;
        })
        .join("");
      mount.innerHTML = `
        <div class="card onboarding-card onboarding-screen-card">
          <button class="onboarding-screen-close" type="button" data-onboarding-action="dismiss" aria-label="退出引导">×</button>
          <div class="card-k">新手引导</div>
          <div class="card-v">选择阶段</div>
          <div class="muted">请选择${roleLabel}当前在学的阶段，系统会自动准备对应词汇。</div>
          <div class="actions mt-10 onboarding-stage-actions">
            ${optionHtml}
          </div>
        </div>
      `;
      hideSprite();
      return;
    }

    hideSprite();
    const current = state.current_step || null;
    const currentTitle = current ? escapeHtml(current.title || "继续") : "继续";
    const currentDesc = current ? escapeHtml(current.desc || "") : "点击按钮继续。";
    const href = String(current?.href || "/").trim();
    const hrefPath = toPath(href);
    const path = currentPath();
    const inReview = path.startsWith("/review");
    const inWorksheetDetail = path.startsWith("/worksheets/");

    if (inReview) {
      // review 页面禁止使用 screen/focus 裁切，避免遮挡单词和评分栏。
      clearFocusScope();
      setScreenMode("");
      setParentGenerateCompact(false);
      const isReviewFirstStep = !!(current && current.key === "self_first_review");
      if (isReviewFirstStep) {
        mount.innerHTML = `
          <div class="onboarding-hud-close">
            <button class="onboarding-screen-close" type="button" data-onboarding-action="dismiss" aria-label="退出引导">×</button>
          </div>
        `;
        return;
      }
      const showJump = !!href && hrefPath && hrefPath !== path;
      mount.innerHTML = showJump
        ? `
          <div class="card onboarding-card onboarding-mini-card">
            <button class="onboarding-screen-close" type="button" data-onboarding-action="dismiss" aria-label="退出引导">×</button>
            <div class="card-k">新手引导</div>
            <div class="card-v">${currentTitle}</div>
            <div class="muted">${currentDesc}</div>
            <div class="actions mt-10 onboarding-step-actions">
              <a class="btn primary" href="${escapeHtml(href)}">${currentTitle}</a>
            </div>
          </div>
        `
        : `
          <div class="onboarding-hud-close">
            <button class="onboarding-screen-close" type="button" data-onboarding-action="dismiss" aria-label="退出引导">×</button>
          </div>
        `;
      return;
    }

    if (inWorksheetDetail) {
      // 作业详情页必须保留完整内容（含打印区），避免被引导裁切成只剩勾错词卡片。
      clearFocusScope();
      setScreenMode("");
      setParentGenerateCompact(false);
      mount.innerHTML = `
        <div class="card onboarding-card onboarding-mini-card">
          <button class="onboarding-screen-close" type="button" data-onboarding-action="dismiss" aria-label="退出引导">×</button>
          <div class="card-k">新手引导</div>
          <div class="card-v">${currentTitle}</div>
          <div class="muted">${currentDesc}</div>
        </div>
      `;
      return;
    }

    const focused = focusCurrentStepScope(current);
    if (!focused) clearFocusScope();
    setScreenMode(focused ? "focus" : "screen");
    const samePage = !!hrefPath && hrefPath === currentPath();
    const showParentGenerateCompact = !!(current && current.key === "parent_generate_sheet" && samePage);
    setParentGenerateCompact(showParentGenerateCompact);

    const showJumpAction = !!href && !!hrefPath && hrefPath !== currentPath();
    const actionHtml = showParentGenerateCompact
      ? `<div class="actions mt-10 onboarding-step-actions"><button class="btn primary" type="button" data-onboarding-action="trigger_step_target">${currentTitle}</button></div>`
      : (showJumpAction
        ? `<div class="actions mt-10 onboarding-step-actions"><a class="btn primary" href="${escapeHtml(href)}">${currentTitle}</a></div>`
        : "");

    mount.innerHTML = `
      <div class="card onboarding-card onboarding-screen-card onboarding-screen-step-card">
        <button class="onboarding-screen-close" type="button" data-onboarding-action="dismiss" aria-label="退出引导">×</button>
        <div class="card-k">新手引导</div>
        <div class="card-v">${currentTitle}</div>
        <div class="muted">${currentDesc}</div>
        ${actionHtml}
      </div>
    `;
  };

  const renderSettingsSummary = (state) => {
    const summaryEl = q("#onboardingSettingsSummary");
    if (!summaryEl) return;

    if (!state || !state.enabled) {
      summaryEl.textContent = "当前未启用引导。";
      return;
    }

    const summary = state.summary || {};
    const done = Number(summary.done || 0);
    const total = Number(summary.total || 0);
    const pct = Number(summary.percent || 0);
    const flowLabel = state.flow === "parent" ? "家长" : "学生";

    if (state.status === "done") {
      summaryEl.textContent = `引导已完成（${done}/${total}）。`;
      return;
    }
    if (state.status === "dismissed") {
      summaryEl.textContent = "引导已关闭，可点击“重新开始”恢复。";
      return;
    }
    if (state.status === "snoozed") {
      summaryEl.textContent = `引导已稍后提醒（${pct}%）。`;
      return;
    }
    if (state.role_selection_required) {
      summaryEl.textContent = "待选择身份：家长或学生。";
      return;
    }
    if (state.stage_selection_required) {
      summaryEl.textContent = "待选择阶段：将按阶段推荐词书。";
      return;
    }
    const next = state.current_step;
    if (next && next.title) {
      summaryEl.textContent = `${flowLabel}流程进行中（${done}/${total}，${pct}%）。下一步：${next.title}`;
      return;
    }
    summaryEl.textContent = `${flowLabel}流程进行中（${done}/${total}，${pct}%）。`;
  };

  const applyState = (state) => {
    if (pendingTimer) {
      window.clearTimeout(pendingTimer);
      pendingTimer = 0;
    }
    cache = state || null;
    const active = !!(cache && cache.enabled && cache.show);
    markOnboardingActiveHint(active);
    setPendingGate(false);
    renderGuideCard(cache);
    renderSettingsSummary(cache);
  };

  const fetchState = async () => {
    const resp = await fetch(STATE_URL, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`state ${resp.status}`);
    return resp.json();
  };

  const postAction = async (action, extra = {}) => {
    const resp = await fetch(ACTION_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    if (!resp.ok) throw new Error(`action ${resp.status}`);
    return resp.json();
  };

  const refresh = async () => {
    if (inflight) return;
    inflight = true;
    try {
      const state = await fetchState();
      applyState(state);
    } catch {
      applyState(null);
    } finally {
      inflight = false;
    }
  };

  const doAction = async (action, extra = {}) => {
    try {
      if (action === "snooze") {
        const state = await postAction("snooze", { hours: 24 });
        applyState(state);
        return;
      }
      const state = await postAction(action, extra);
      applyState(state);
      maybeAutoNavigateToCurrentStep(state, action);
    } catch {
      await refresh();
    }
  };

  const scheduleReposition = () => {
    if (positionRaf) return;
    positionRaf = window.requestAnimationFrame(() => {
      positionRaf = 0;
      if (!cache) return;
      renderSprite(cache);
    });
  };

  document.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target.closest("[data-onboarding-action]") : null;
    if (!target) return;
    e.preventDefault();

    const action = String(target.getAttribute("data-onboarding-action") || "").trim().toLowerCase();
    if (!action) return;

    if (action === "choose_role") {
      const role = String(target.getAttribute("data-onboarding-role") || "").trim().toLowerCase();
      if (!role) return;
      void doAction("choose_role", { role });
      return;
    }
    if (action === "choose_stage") {
      const stage = String(target.getAttribute("data-onboarding-stage") || "").trim().toLowerCase();
      if (!stage) return;
      void doAction("choose_stage", { stage });
      return;
    }
    if (action === "trigger_step_target") {
      triggerCurrentStep();
      return;
    }

    void doAction(action);
  });

  document.addEventListener("DOMContentLoaded", () => {
    try {
      if (window.sessionStorage.getItem(ONBOARDING_ACTIVE_KEY) === "1") {
        setPendingGate(true);
      }
    } catch {}
    void refresh();
  });

  document.addEventListener("htmx:afterSwap", (e) => {
    const target = e?.detail?.target;
    if (!target || target.id !== "content") return;
    try {
      if (window.sessionStorage.getItem(ONBOARDING_ACTIVE_KEY) === "1") {
        setPendingGate(true);
      }
    } catch {}
    void refresh();
  });

  window.addEventListener("resize", scheduleReposition, { passive: true });
  window.addEventListener("orientationchange", scheduleReposition, { passive: true });
  window.addEventListener("scroll", scheduleReposition, { passive: true, capture: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleReposition();
  });

  window.vsOnboarding = { refresh };
})();
