(() => {
  const AUTH_FORM_SELECTOR = 'form[action="/auth/login"], form[action="/auth/register"]';
  const EYE_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18"/><path d="M10.58 10.58a2 2 0 0 0 2.83 2.83"/><path d="M9.88 5.09A10.94 10.94 0 0 1 12 5c5 0 9.27 3.11 11 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 1 12c1.73 3.89 6 7 11 7 1.61 0 3.16-.33 4.56-.91"/></svg>';

  const bindPasswordToggle = (input, toggle) => {
    if (!(input instanceof HTMLInputElement)) return;
    if (!(toggle instanceof HTMLButtonElement)) return;
    if (toggle.dataset.authToggleBound === "1") return;
    toggle.dataset.authToggleBound = "1";

    const syncToggleState = () => {
      const shown = input.type === "text";
      toggle.classList.toggle("is-on", shown);
      toggle.innerHTML = shown ? EYE_ICON : EYE_OFF_ICON;
      toggle.setAttribute("aria-label", shown ? "隐藏密码" : "显示密码");
      toggle.setAttribute("aria-pressed", shown ? "true" : "false");
      toggle.setAttribute("title", shown ? "隐藏密码" : "显示密码");
    };

    syncToggleState();

    toggle.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
    });

    toggle.addEventListener("click", () => {
      const nextType = input.type === "password" ? "text" : "password";
      input.type = nextType;
      syncToggleState();
      input.focus();
      try {
        input.setSelectionRange(input.value.length, input.value.length);
      } catch {}
    });
  };

  const setupPasswordField = (input) => {
    if (!(input instanceof HTMLInputElement)) return;
    if (input.dataset.authEnhanced === "1") return;

    let wrap = input.closest(".auth-pass-wrap");
    if (!(wrap instanceof HTMLElement)) {
      wrap = document.createElement("span");
      wrap.className = "auth-pass-wrap";
      input.parentNode?.insertBefore(wrap, input);
      wrap.appendChild(input);
    }

    let toggle = wrap.querySelector("[data-auth-pass-toggle], .auth-pass-eye");
    if (!(toggle instanceof HTMLButtonElement)) {
      toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "auth-pass-eye";
      toggle.setAttribute("data-auth-pass-toggle", "");
      wrap.appendChild(toggle);
    }

    bindPasswordToggle(input, toggle);
    input.dataset.authEnhanced = "1";
  };

  const bindAuthForm = (form) => {
    if (!(form instanceof HTMLFormElement)) return;
    if (form.dataset.authBound === "1") return;
    form.dataset.authBound = "1";
    form.dataset.submitting = "0";

    const inputs = form.querySelectorAll("input");
    inputs.forEach((input) => {
      if (!(input instanceof HTMLInputElement)) return;
      if (input.type === "password") setupPasswordField(input);
      input.addEventListener("input", () => {
        input.classList.remove("is-invalid");
      });
    });

    form.addEventListener("submit", (ev) => {
      if (form.dataset.submitting === "1") {
        ev.preventDefault();
        return;
      }
      form.dataset.submitting = "1";

      const submitter = ev.submitter instanceof HTMLButtonElement ? ev.submitter : null;
      const button = submitter || form.querySelector('button[type="submit"]');
      if (button instanceof HTMLButtonElement) {
        button.disabled = true;
        if (!button.dataset.originalText) {
          button.dataset.originalText = button.textContent || "";
        }
        button.textContent = "提交中...";
      }
    });
  };

  const setup = (root = document) => {
    const forms = root.querySelectorAll ? root.querySelectorAll(AUTH_FORM_SELECTOR) : [];
    forms.forEach(bindAuthForm);
  };

  document.addEventListener("DOMContentLoaded", () => {
    setup(document);
  });

  document.addEventListener("htmx:afterSwap", (e) => {
    const target = e?.detail?.target;
    if (!target || target.id !== "content") return;
    setup(target);
  });

  window.addEventListener("pageshow", () => {
    document.querySelectorAll(AUTH_FORM_SELECTOR).forEach((form) => {
      if (!(form instanceof HTMLFormElement)) return;
      form.dataset.submitting = "0";
      form.querySelectorAll('button[type="submit"]').forEach((btn) => {
        if (!(btn instanceof HTMLButtonElement)) return;
        btn.disabled = false;
        if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText;
      });
    });
  });

  // Fallback: if a swapped DOM misses direct binding, clicking eye still toggles password visibility.
  document.addEventListener("click", (ev) => {
    const toggle = ev.target instanceof Element ? ev.target.closest("[data-auth-pass-toggle]") : null;
    if (!(toggle instanceof HTMLButtonElement)) return;
    if (toggle.dataset.authToggleBound === "1") return;

    const wrap = toggle.closest(".auth-pass-wrap");
    const input = wrap ? wrap.querySelector("input") : null;
    if (!(input instanceof HTMLInputElement)) return;

    setupPasswordField(input);
    if (toggle.dataset.authToggleBound === "1") return;

    const shown = input.type === "text";
    const nextType = shown ? "password" : "text";
    input.type = nextType;
    const nowShown = input.type === "text";
    toggle.classList.toggle("is-on", nowShown);
    toggle.innerHTML = nowShown ? EYE_ICON : EYE_OFF_ICON;
    toggle.setAttribute("aria-label", nowShown ? "隐藏密码" : "显示密码");
    toggle.setAttribute("aria-pressed", nowShown ? "true" : "false");
    toggle.setAttribute("title", nowShown ? "隐藏密码" : "显示密码");
  });
})();
