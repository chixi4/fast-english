(() => {
  const STATE_URL = "/api/onboarding/state";
  const ACTION_URL = "/api/onboarding/action";
  const ONBOARDING_ACTIVE_KEY = "vs_onboarding_active";
  const AUTO_NAV_GUARD_KEY = "vs_onboarding_auto_nav_guard";
  const COMPLETION_NOTICE_KEY = "vs_onboarding_done_notice";
  const AUTO_NAV_GUARD_TTL_MS = 8000;
  const TRIGGER_STEP_LOCK_MS = 700;
  const PREP_POLL_INTERVAL_MS = 800;
  const PREP_POLL_MAX_ROUNDS = 24;
  const API_FETCH_TIMEOUT_MS = 6000;
  const MOUNT_ID = "onboardingGuideMount";
  const SPRITE_ID = "onboardingSprite";
  const TOOLTIP_ID = "onboardingTooltip";

  let inflight = false;
  let actionInFlight = false;
  let cache = null;
  let positionRaf = 0;
  let pendingTimer = 0;
  let triggerStepLockedUntil = 0;
  let prepPollTimer = 0;
  let prepPollRounds = 0;
  let hudSuppressedPath = "";
  let lastRenderSignature = "";

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
  const isReviewReadyForRating = () => {
    try {
      return !!document.querySelector('#reviewRateForm button[name="rating"]');
    } catch {
      return false;
    }
  };
  const focusReviewRatingArea = () => {
    const bar = q("#reviewBottomBar") || q(".review-bottombar");
    const form = q("#reviewRateForm");
    const target = bar || form;
    if (!target) return false;
    try {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {
      try { target.scrollIntoView(); } catch {}
    }
    target.classList.add("onboarding-rating-focus");
    window.setTimeout(() => target.classList.remove("onboarding-rating-focus"), 1200);
    return true;
  };
  const toPath = (href) => {
    try {
      return String(new URL(String(href || ""), window.location.origin).pathname || "/");
    } catch {
      return "";
    }
  };
  const readAutoNavGuard = () => {
    try {
      const raw = window.sessionStorage.getItem(AUTO_NAV_GUARD_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const ts = Number(parsed.ts || 0);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return {
        key: String(parsed.key || ""),
        href: String(parsed.href || ""),
        ts,
      };
    } catch {
      return null;
    }
  };
  const writeAutoNavGuard = (step) => {
    if (!step) return;
    const payload = {
      key: String(step.key || ""),
      href: toPath(String(step.href || "").trim()),
      ts: Date.now(),
    };
    try {
      window.sessionStorage.setItem(AUTO_NAV_GUARD_KEY, JSON.stringify(payload));
    } catch {}
  };
  const shouldBlockAutoNav = (step) => {
    if (!step) return false;
    const guard = readAutoNavGuard();
    if (!guard) return false;
    if ((Date.now() - guard.ts) > AUTO_NAV_GUARD_TTL_MS) return false;
    const stepKey = String(step.key || "");
    const stepHref = toPath(String(step.href || "").trim());
    return !!(guard.key && guard.key === stepKey && guard.href && guard.href === stepHref);
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
  const markDoneNoticePending = (pending) => {
    try {
      if (pending) window.sessionStorage.setItem(COMPLETION_NOTICE_KEY, "1");
      else window.sessionStorage.removeItem(COMPLETION_NOTICE_KEY);
    } catch {}
  };
  const hasDoneNoticePending = () => {
    try {
      return window.sessionStorage.getItem(COMPLETION_NOTICE_KEY) === "1";
    } catch {
      return false;
    }
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

  const stopPrepPoll = () => {
    if (prepPollTimer) {
      window.clearTimeout(prepPollTimer);
      prepPollTimer = 0;
    }
    prepPollRounds = 0;
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

  const fetchJsonWithTimeout = async (url, init = {}, timeoutMs = API_FETCH_TIMEOUT_MS) => {
    const ctl = new AbortController();
    const timer = window.setTimeout(() => ctl.abort(), Math.max(1200, Number(timeoutMs || API_FETCH_TIMEOUT_MS)));
    try {
      const resp = await fetch(url, { ...init, signal: ctl.signal });
      return resp;
    } finally {
      window.clearTimeout(timer);
    }
  };

  const replaceNavigate = (href) => {
    const url = String(href || "").trim();
    if (!url) return false;
    beginPendingNavigation();
    try {
      window.location.replace(url);
    } catch {
      window.location.href = url;
    }
    return true;
  };

  const pollPrepAndNavigate = (fallbackHref) => {
    stopPrepPoll();
    const fbPath = toPath(String(fallbackHref || "").trim());
    if (!fbPath) return;

    const tick = async () => {
      prepPollRounds += 1;
      if (prepPollRounds > PREP_POLL_MAX_ROUNDS) {
        stopPrepPoll();
        setPendingGate(false);
        return;
      }

      try {
        const state = await fetchState();
        applyState(state);
        const status = String(state?.prep_status || "ready").trim().toLowerCase();
        const href = String(state?.next_href || fallbackHref || "").trim();
        const hrefPath = toPath(href);
        if (status === "ready" && hrefPath && hrefPath !== currentPath()) {
          stopPrepPoll();
          replaceNavigate(href);
          return;
        }
      } catch {
        // keep polling briefly; transient fetch errors should not break onboarding flow
      }
      prepPollTimer = window.setTimeout(tick, PREP_POLL_INTERVAL_MS);
    };
    prepPollTimer = window.setTimeout(tick, PREP_POLL_INTERVAL_MS);
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
    const path = currentPath();
    if (h1 && h1.parentNode && path.startsWith("/simulations/")) {
      h1.insertAdjacentElement("beforebegin", mount);
    } else if (h1 && h1.parentNode) {
      h1.insertAdjacentElement("afterend", mount);
    } else {
      container.prepend(mount);
    }
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
  const setHudActive = (on) => {
    document.body.classList.toggle("onboarding-hud-active", !!on);
  };
  const setMistakesHudAdjust = (on) => {
    document.body.classList.toggle("onboarding-mistakes-hud-adjust", !!on);
  };
  const setParentGenerateCompact = (on) => {
    document.body.classList.toggle("onboarding-hide-parent-generate-btn", !!on);
  };
  const setOpaqueMask = (on) => {
    document.body.classList.toggle("onboarding-opaque-mask-active", !!on);
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
      let node = q(sel);
      if (!node && String(step.key || "") === "self_first_review") {
        const path = currentPath();
        if (path.startsWith("/review")) node = q('[data-guide-anchor="self-first-review-review"]');
        else if (path === "/") node = q('[data-guide-anchor="self-first-review-home"]');
      }
      return node;
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
    const now = Date.now();
    if (now < triggerStepLockedUntil) return;
    triggerStepLockedUntil = now + TRIGGER_STEP_LOCK_MS;

    const step = cache?.current_step;
    if (!step) return;
    const stepKey = String(step.key || "").trim();
    const forceReviewRetry = () => {
      if (stepKey !== "self_first_review") return false;
      if (currentPath().startsWith("/review") && isReviewReadyForRating()) {
        return focusReviewRatingArea();
      }
      return htmxNavigate("/review?onboarding_retry=1", { pushURL: true });
    };

    if (stepKey === "self_first_review" && currentPath().startsWith("/review") && !isReviewReadyForRating()) {
      forceReviewRetry();
      return;
    }

    const target = findTarget(step);
    if (target && triggerNode(target)) return;

    if (!target && forceReviewRetry()) return;

    const href = String(step.href || "").trim();
    const hrefPath = toPath(href);
    if (!target && hrefPath && hrefPath === currentPath()) {
      if (forceReviewRetry()) return;
      return;
    }
    if (href) {
      htmxNavigate(href, { pushURL: true });
      return;
    }
    forceReviewRetry();
  };

  const maybeAutoNavigateToCurrentStep = (state, triggerAction) => {
    if (!state || !state.enabled || !state.show) return false;
    const fromRoleOrStage = triggerAction === "choose_stage" || triggerAction === "choose_role";
    if (!fromRoleOrStage) return false;
    if (state.role_selection_required || state.stage_selection_required) return false;
    const step = state.current_step || null;
    if (!step) return false;
    if (shouldBlockAutoNav(step)) return false;
    const href = String(step.href || "").trim();
    if (!href) return false;
    const hrefPath = toPath(href);
    if (!hrefPath || hrefPath === currentPath()) return false;
    writeAutoNavGuard(step);
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
    setMistakesHudAdjust(false);

    if (!state || !state.enabled || !state.show) {
      const status = String(state?.status || "").trim().toLowerCase();
      const showDoneNotice = (
        status === "done"
        && hasDoneNoticePending()
        && currentPath().startsWith("/dashboard")
      );
      if (showDoneNotice) {
        clearFocusScope();
        setScreenMode("");
        setHudActive(false);
        setOpaqueMask(false);
        setParentGenerateCompact(false);
        mount.innerHTML = `
          <div class="card onboarding-card onboarding-mini-card">
            <button class="onboarding-screen-close" type="button" data-onboarding-action="hide_done_notice" aria-label="关闭提示">×</button>
            <div class="card-k">新手引导</div>
            <div class="card-v">引导已完成</div>
            <div class="muted">你已经走完入门流程，现在可以按自己的节奏学习了。向下滑动可查看高频错词和统计明细。</div>
            <div class="actions mt-10 onboarding-step-actions">
              <button class="btn primary" type="button" data-onboarding-action="hide_done_notice">开始自主学习</button>
            </div>
          </div>
        `;
        hideSprite();
        return;
      }
      mount.innerHTML = "";
      setScreenMode("");
      setHudActive(false);
      setOpaqueMask(false);
      setParentGenerateCompact(false);
      clearFocusScope();
      hideSprite();
      return;
    }

    if (state.role_selection_required) {
      setScreenMode("screen");
      setHudActive(false);
      setOpaqueMask(false);
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
      setHudActive(false);
      setOpaqueMask(false);
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
    const inMistakes = path.startsWith("/mistakes");
    const inReview = path.startsWith("/review");
    const inSimulation = path.startsWith("/simulations/");
    const inWorksheetDetail = path.startsWith("/worksheets/");
    if (hudSuppressedPath && hudSuppressedPath !== path) hudSuppressedPath = "";

    const renderPinnedHud = (opts = {}) => {
      const title = escapeHtml(opts.title || currentTitle);
      const desc = escapeHtml(opts.desc || currentDesc);
      const actionHtml = String(opts.actionHtml || "");
      const showClose = opts.showClose !== false;
      setHudActive(true);
      mount.innerHTML = `
        <div class="onboarding-hud-pin">
          <div class="card onboarding-card onboarding-mini-card onboarding-hud-card">
            <div class="card-k">新手引导</div>
            <div class="onboarding-hud-title">${title}</div>
            ${desc ? `<div class="onboarding-hud-desc">${desc}</div>` : ""}
            ${actionHtml}
          </div>
        </div>
        ${showClose ? `
        <div class="onboarding-hud-close">
          <button class="onboarding-screen-close" type="button" data-onboarding-action="dismiss" aria-label="退出引导">×</button>
        </div>` : ""}
      `;
    };

    if (inMistakes && current && current.key === "self_try_mistakes") {
      clearFocusScope();
      setScreenMode("");
      setParentGenerateCompact(false);
      setOpaqueMask(false);
      setMistakesHudAdjust(false);
      const generateCard = q(".mistakes-generate-card");
      if (generateCard && mount.parentElement !== generateCard) {
        const form = q("#generateForm", generateCard);
        if (form && form.parentNode) {
          form.insertAdjacentElement("beforebegin", mount);
        } else {
          generateCard.prepend(mount);
        }
      }
      if (hudSuppressedPath === path) {
        setHudActive(false);
        mount.innerHTML = "";
        return;
      }
      setHudActive(false);
      mount.innerHTML = `
        <div class="card onboarding-card onboarding-mini-card onboarding-mistakes-inline-card">
          <button class="onboarding-screen-close" type="button" data-onboarding-action="dismiss" aria-label="退出引导">×</button>
          <div class="card-k">新手引导</div>
          <div class="onboarding-hud-title">进入错词篮练习</div>
          <div class="muted">点击“生成短文练习”开始。</div>
        </div>
      `;
      return;
    }

    if (inSimulation) {
      // 短文阅读页改为内嵌卡片提示，避免固定悬浮遮挡正文。
      clearFocusScope();
      setScreenMode("");
      setParentGenerateCompact(false);
      setOpaqueMask(false);
      setHudActive(false);
      const nextHref = (href && hrefPath && hrefPath !== path) ? href : "/dashboard";
      mount.innerHTML = `
        <div class="card onboarding-card onboarding-mini-card onboarding-sim-inline-card">
          <button class="onboarding-screen-close" type="button" data-onboarding-action="dismiss" aria-label="退出引导">×</button>
          <div class="card-k">新手引导</div>
          <div class="onboarding-hud-title">实战短文：先读再做题</div>
          <div class="muted">这页是短文练习页。你可以先读题并作答；完成后到看板查看掌握率变化。</div>
          <div class="actions mt-10 onboarding-step-actions">
            <a class="btn primary" href="${escapeHtml(nextHref)}">${currentTitle}</a>
          </div>
        </div>
      `;
      return;
    }

    if (inReview) {
      clearFocusScope();
      setScreenMode("");
      const reviewReady = isReviewReadyForRating();
      setOpaqueMask(!reviewReady);
      setParentGenerateCompact(false);
      if (hudSuppressedPath === path) {
        setHudActive(false);
        setOpaqueMask(false);
        mount.innerHTML = `
          <div class="onboarding-hud-close">
            <button class="onboarding-screen-close" type="button" data-onboarding-action="dismiss" aria-label="退出引导">×</button>
          </div>
        `;
        return;
      }
      const showJump = !!href && hrefPath && hrefPath !== path;
      const actionHtml = showJump
        ? `<div class="actions mt-10 onboarding-step-actions"><a class="btn primary" href="${escapeHtml(href)}">${currentTitle}</a></div>`
        : (reviewReady
          ? ""
          : `<div class="actions mt-10 onboarding-step-actions"><button class="btn primary" type="button" data-onboarding-action="trigger_step_target">${currentTitle}</button></div>`);
      const reviewDesc = reviewReady
        ? "继续在下方完成评分，本轮背词中引导会保持显示。"
        : currentDesc;
      setHudActive(true);
      mount.innerHTML = `
        <div class="onboarding-hud-pin onboarding-review-hud">
          <div class="card onboarding-card onboarding-mini-card onboarding-hud-card onboarding-review-hud-card">
            <div class="card-k">新手引导</div>
            <div class="onboarding-hud-title">${currentTitle}</div>
            ${reviewDesc ? `<div class="onboarding-hud-desc">${reviewDesc}</div>` : ""}
            ${actionHtml}
          </div>
        </div>
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
      setHudActive(false);
      setOpaqueMask(false);
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
    setHudActive(false);
    setOpaqueMask(false);
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
    const prevStatus = String(cache?.status || "").trim().toLowerCase();
    cache = state || null;
    const nextStatus = String(cache?.status || "").trim().toLowerCase();
    if (nextStatus === "done" && prevStatus !== "done") {
      markDoneNoticePending(true);
    } else if (nextStatus && nextStatus !== "done") {
      markDoneNoticePending(false);
    }
    const active = !!(cache && cache.enabled && cache.show);
    if (!active) stopPrepPoll();
    markOnboardingActiveHint(active);
    setPendingGate(false);
    const renderSignature = JSON.stringify({
      p: currentPath(),
      st: String(cache?.status || ""),
      sh: !!cache?.show,
      en: !!cache?.enabled,
      roleReq: !!cache?.role_selection_required,
      stageReq: !!cache?.stage_selection_required,
      stepKey: String(cache?.current_step?.key || ""),
      stepHref: String(cache?.current_step?.href || ""),
      doneNotice: hasDoneNoticePending(),
      hudSuppressedPath,
    });
    const mount = q(`#${MOUNT_ID}`);
    if (!mount || renderSignature !== lastRenderSignature) {
      renderGuideCard(cache);
      lastRenderSignature = renderSignature;
    }
    renderSettingsSummary(cache);
    document.documentElement.classList.remove("onboarding-entry-pending");
  };

  const fetchState = async () => {
    const resp = await fetchJsonWithTimeout(STATE_URL, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }, API_FETCH_TIMEOUT_MS);
    if (!resp.ok) throw new Error(`state ${resp.status}`);
    return resp.json();
  };

  const postAction = async (action, extra = {}) => {
    const resp = await fetchJsonWithTimeout(ACTION_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ action, ...extra }),
    }, API_FETCH_TIMEOUT_MS);
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
    if (actionInFlight) return;
    actionInFlight = true;
    try {
      if (action === "snooze") {
        const state = await postAction("snooze", { hours: 24 });
        applyState(state);
        return;
      }
      const state = await postAction(action, extra);
      applyState(state);
      if (action === "choose_stage") {
        const nextHref = String(state?.next_href || "").trim();
        const nextPath = toPath(nextHref);
        if (nextHref && nextPath && nextPath !== currentPath()) {
          htmxNavigate(nextHref, { pushURL: true });
        }
        return;
      }

      maybeAutoNavigateToCurrentStep(state, action);
    } catch {
      await refresh();
    } finally {
      actionInFlight = false;
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
    const startNode = e.target instanceof Element ? e.target.closest("[data-onboarding-start]") : null;
    if (startNode) {
      const lock = String(startNode.getAttribute("data-onboarding-loading") || "").trim();
      if (lock === "1") {
        e.preventDefault();
        return;
      }
      startNode.setAttribute("data-onboarding-loading", "1");
      startNode.classList.add("is-loading");
      const label = String(startNode.getAttribute("data-loading-label") || "").trim();
      if (label) {
        const labelEl = startNode.querySelector(".btn-label");
        if (labelEl) {
          if (!labelEl.getAttribute("data-original-label")) {
            labelEl.setAttribute("data-original-label", String(labelEl.textContent || ""));
          }
          labelEl.textContent = label;
        } else {
          if (!startNode.getAttribute("data-original-label")) {
            startNode.setAttribute("data-original-label", String(startNode.textContent || "").trim());
          }
          startNode.textContent = label;
        }
      }
      window.setTimeout(() => {
        if (!document.contains(startNode)) return;
        startNode.classList.remove("is-loading");
        startNode.setAttribute("data-onboarding-loading", "0");
        const labelEl = startNode.querySelector(".btn-label");
        if (labelEl) {
          const orig = labelEl.getAttribute("data-original-label");
          if (orig) labelEl.textContent = orig;
        } else {
          const orig = startNode.getAttribute("data-original-label");
          if (orig) startNode.textContent = orig;
        }
      }, 12000);
    }

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
    if (action === "hide_done_notice") {
      markDoneNoticePending(false);
      const mount = ensureMount();
      if (mount) mount.innerHTML = "";
      setHudActive(false);
      lastRenderSignature = "";
      return;
    }
    if (action === "focus_review_rating") {
      focusReviewRatingArea();
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

  document.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const path = currentPath();
    const guide = target.closest("[data-guide-anchor]");
    if (guide) {
      const anchor = String(guide.getAttribute("data-guide-anchor") || "");
      if (anchor === "self-try-mistakes" || anchor === "self-first-review-review" || anchor === "open-dashboard" || anchor === "nav-dashboard") {
        window.setTimeout(() => { void refresh(); }, 900);
        window.setTimeout(() => { void refresh(); }, 2200);
      }
      if (anchor === "self-try-mistakes" && path.startsWith("/mistakes")) {
        hudSuppressedPath = path;
        lastRenderSignature = "";
        renderGuideCard(cache);
      }
    }
    if (target.closest('button[name="rating"]') && path.startsWith("/review")) {
      // 背词阶段保持引导常驻，不在每次评分后隐藏或强刷状态。
      }
    if (
      target.closest('form[action*="/simulations/"][method="post"] button[type="submit"]')
      && path.startsWith("/simulations/")
    ) {
      hudSuppressedPath = path;
      lastRenderSignature = "";
      renderGuideCard(cache);
      window.setTimeout(() => { void refresh(); }, 1200);
      window.setTimeout(() => { void refresh(); }, 2600);
    }
  }, { capture: true });

  window.addEventListener("scroll", () => {
    const path = currentPath();
    if (!path.startsWith("/simulations/")) return;
    if ((window.scrollY || 0) < 90) return;
    if (hudSuppressedPath === path) return;
    hudSuppressedPath = path;
    lastRenderSignature = "";
    renderGuideCard(cache);
  }, { passive: true, capture: true });

  window.addEventListener("resize", scheduleReposition, { passive: true });
  window.addEventListener("orientationchange", scheduleReposition, { passive: true });
  window.addEventListener("scroll", scheduleReposition, { passive: true, capture: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleReposition();
  });

  window.vsOnboarding = { refresh };
})();
