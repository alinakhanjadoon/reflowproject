/**
 * ReFlow — Session Authentication & Login Sequence Detector
 * 
 * Inspects recorded workflow steps to identify initial authentication/login sequences,
 * and probes the active browser tab to detect whether an authenticated session is already active.
 * Allows workflow replay to skip redundant login steps and advance directly to post-login actions.
 */

/**
 * Checks if a single action appears to be part of a login/authentication flow
 * @param {object} action - Recorded action object
 * @returns {boolean}
 */
/**
 * Checks if a single action appears to be part of a login/authentication flow
 * @param {object} action - Recorded action object
 * @returns {boolean}
 */
function isLoginAction(action) {
  if (!action) return false;

  const type = (action.type || action.action || '').toUpperCase();
  const name = String(action.name || action.elementName || '').toLowerCase();
  const target = action.target || {};
  const fingerprint = target.fingerprint || action.fingerprint || {};
  const candidates = Array.isArray(target.candidates) ? target.candidates : [];

  // 1. Password input action
  if (type === 'TYPE' || type === 'CLICK') {
    if (action.meta?.isPassword || fingerprint.isPassword) return true;
    if (fingerprint.type === 'password') return true;
    if (/password|pwd/i.test(name)) return true;
    if (candidates.some(c => c.value && /password/i.test(c.value))) return true;
  }

  // 2. Username / Email input action (click or type)
  if (type === 'TYPE' || type === 'CLICK') {
    const isUserField = /user(name)?|email|user_id|userid/i.test(name) ||
      /user(name)?|email|user_id|userid/i.test(fingerprint.name || '') ||
      /user(name)?|email|user_id|userid/i.test(fingerprint.placeholder || '') ||
      /user(name)?|email|user_id|userid/i.test(fingerprint.id || '');
    if (isUserField) return true;
    if (candidates.some(c => c.value && /(username|user_name|user-name|email|login_id)/i.test(c.value))) return true;
  }

  // 3. Login / Sign In / Submit button click
  if (type === 'CLICK') {
    const isButton = fingerprint.tagName === 'button' ||
      fingerprint.role === 'button' ||
      fingerprint.type === 'submit' ||
      /button|btn/i.test(name) ||
      candidates.some(c => c.value && /(\/\/button|button\[|\.btn|input\[type=['"]?submit)/i.test(c.value));

    const hasLoginText = /(log ?in|sign ?in|submit|continue|auth)\b/i.test(name) ||
      /(log ?in|sign ?in|submit|continue|auth)\b/i.test(fingerprint.text || '') ||
      /(log ?in|sign ?in|submit|continue|auth)\b/i.test(fingerprint.ariaLabel || '');

    if (isButton && hasLoginText) return true;
    if (candidates.some(c => c.value && /(button.*(log ?in|sign ?in)|btn-login|login-button|signin)/i.test(c.value))) return true;
  }

  // 4. Navigate to explicit login/auth URL
  if ((type === 'NAVIGATE' || type === 'navigate') && action.url) {
    if (/\/(login|signin|auth)\b/i.test(action.url) || /#(.*)\/(login|signin)/i.test(action.url)) {
      return true;
    }
  }

  return false;
}

/**
 * Detects an initial login sequence within a workflow's action list.
 * Identifies the range [startIndex, endIndex] and the firstPostLoginIndex.
 * 
 * @param {Array<object>} actions - List of workflow actions
 * @returns {object} Login sequence metadata
 */
function detectLoginSequence(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return {
      hasLoginSequence: false,
      startIndex: -1,
      endIndex: -1,
      firstPostLoginIndex: 0,
      loginActions: [],
      firstPostLoginAction: null
    };
  }

  let passwordIndex = -1;
  let usernameIndex = -1;
  let submitIndex = -1;
  let lastLoginStepIndex = -1;

  // Search within the first 15 actions for an authentication sequence
  const searchLimit = Math.min(actions.length, 15);
  for (let i = 0; i < searchLimit; i++) {
    const action = actions[i];
    const type = (action.type || action.action || '').toUpperCase();
    const name = String(action.name || action.elementName || '').toLowerCase();
    const fp = action.target?.fingerprint || action.fingerprint || {};
    const candidates = Array.isArray(action.target?.candidates) ? action.target.candidates : [];
    const url = action.url || '';
    const isLoginUrl = /\/(login|signin|auth)\b/i.test(url) || /#(.*)\/(login|signin)/i.test(url);

    // Initial navigation to login URL
    if ((type === 'NAVIGATE' || type === 'navigate') && isLoginUrl) {
      lastLoginStepIndex = i;
      continue;
    }

    const isPassword = (action.meta?.isPassword || fp.type === 'password' || /password|pwd/i.test(name)) ||
      candidates.some(c => c.value && /password/i.test(c.value));
    if (isPassword) {
      passwordIndex = i;
      lastLoginStepIndex = i;
    }

    const isUser = (!isPassword && !/button|btn|submit/i.test(name)) && (
      /user(name)?|email|user_id|userid/i.test(name) ||
      /user(name)?|email|user_id|userid/i.test(fp.name || '') ||
      candidates.some(c => c.value && /(username|user_name|user-name|email)/i.test(c.value))
    );
    if (isUser) {
      usernameIndex = i;
      lastLoginStepIndex = i;
    }

    const isInput = type === 'TYPE' ||
      (fp.tagName === 'input' && fp.type !== 'submit' && fp.type !== 'button') ||
      (/input|field|textbox/i.test(name) && !/button|btn|submit/i.test(name)) ||
      candidates.some(c => c.value && /(> *input|\/input\[|mat-select)/i.test(c.value));

    // Submit button must be a CLICK on a button/submit element with login/signin/submit text
    const isSubmitButton = type === 'CLICK' && !isInput && (
      /(log ?in|sign ?in|submit|continue)\b/i.test(name) ||
      /(log ?in|sign ?in|submit|continue)\b/i.test(fp.text || '') ||
      /(log ?in|sign ?in|submit|continue)\b/i.test(fp.ariaLabel || '') ||
      candidates.some(c => c.value && /(\/\/button.*(log ?in|sign ?in)|button\[.*(log ?in|sign ?in)|btn-login|login-btn|signin-btn|input\[type=['"]?submit)/i.test(c.value))
    );

    if (isSubmitButton) {
      submitIndex = i;
      lastLoginStepIndex = i;
      // If we already saw password or username, this submit button completes the login sequence!
      if (passwordIndex >= 0 || usernameIndex >= 0) {
        break;
      }
    }

    // Password visibility toggle or checkbox on login form
    if (type === 'CLICK' && isLoginUrl && (passwordIndex >= 0 || usernameIndex >= 0)) {
      if (/password|eye|toggle|remember/i.test(name) || /password|eye|toggle|remember/i.test(fp.ariaLabel || '')) {
        lastLoginStepIndex = i;
      }
    }
  }

  // If we found a password step and/or a submit step
  if (passwordIndex >= 0 || (usernameIndex >= 0 && submitIndex >= 0) || submitIndex >= 0) {
    const endIndex = submitIndex >= 0 ? submitIndex : lastLoginStepIndex;
    const startIndex = 0;
    const firstPostLoginIndex = endIndex + 1;

    return {
      hasLoginSequence: true,
      startIndex,
      endIndex,
      loginActionCount: endIndex - startIndex + 1,
      firstPostLoginIndex,
      loginActions: actions.slice(startIndex, firstPostLoginIndex),
      firstPostLoginAction: actions[firstPostLoginIndex] || null
    };
  }

  return {
    hasLoginSequence: false,
    startIndex: -1,
    endIndex: -1,
    firstPostLoginIndex: 0,
    loginActions: [],
    firstPostLoginAction: actions[0] || null
  };
}

/**
 * Evaluates whether the active browser tab currently has an authenticated session.
 * Probes the page URL, absence of login forms, and presence of post-login targets.
 * 
 * @param {object} page - Puppeteer page instance
 * @param {object} loginSeq - Result from detectLoginSequence()
 * @param {object} [options] - Options (timeoutMs, etc.)
 * @returns {Promise<boolean>} True if the page appears already logged in
 */
async function isSessionAuthenticated(page, loginSeq = {}, options = {}) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false;

  try {
    const currentUrl = page.url();
    if (!currentUrl || currentUrl === 'about:blank' || currentUrl.startsWith('chrome://')) {
      return false;
    }

    // 1. If the current URL is explicitly a login/signin/auth route, it is NOT authenticated
    const isLoginUrl = /\/(login|signin|auth)\b/i.test(currentUrl) || /#(.*)\/(login|signin)\b/i.test(currentUrl);
    if (isLoginUrl) {
      return false;
    }

    // 2. Check if the page displays any login form or login credentials prompts
    const hasLoginForm = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        if (el.offsetParent === null && el.tagName.toLowerCase() !== 'body') return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0.1;
      };

      // Visible password input
      const passwordInputs = Array.from(document.querySelectorAll('input[type="password"], input[name*="password" i], input[id*="password" i]'));
      if (passwordInputs.some(isVisible)) return true;

      // Visible "Log In" / "Sign In" button or submit button
      const allButtons = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn, a[role="button"]'));
      const hasLoginButton = allButtons.some(el => {
        if (!isVisible(el)) return false;
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
        return /^(log ?in|sign ?in)$/i.test(text);
      });
      if (hasLoginButton) return true;

      return false;
    }).catch(() => false);

    if (hasLoginForm) {
      return false;
    }

    // 3. Check for 2FA / OTP challenges
    const is2faUrl = /\/(2fa|mfa|two-factor|two-step|challenge|otp|verify|verification|security-code)\b/i.test(currentUrl);
    if (is2faUrl) return false;

    const hasVisibleOtpInput = await page.evaluate(() => {
      const otpSelectors = [
        'input[autocomplete="one-time-code"]',
        'input[name*="otp" i]', 'input[id*="otp" i]',
        'input[name*="2fa" i]', 'input[id*="2fa" i]',
        'input[name*="mfa" i]', 'input[id*="mfa" i]',
        'input[name*="verification" i]', 'input[id*="verification" i]',
        'iframe#duo_iframe', 'iframe[src*="duosecurity.com"]'
      ];
      return otpSelectors.some(sel => {
        const el = document.querySelector(sel);
        return el && (el.offsetParent !== null || el.tagName === 'IFRAME');
      });
    }).catch(() => false);
    if (hasVisibleOtpInput) return false;

    // 4. Target Element Probe: Can we already find the target of firstPostLoginAction?
    // If the element targeted immediately after login is visible and present on this page,
    // we are definitely authenticated!
    if (loginSeq.firstPostLoginAction && loginSeq.firstPostLoginAction.target) {
      const targetCandidates = loginSeq.firstPostLoginAction.target.candidates || [];
      const hasTarget = await page.evaluate((candidates) => {
        const visible = (el) => {
          if (!el) return false;
          if (el.offsetParent === null && el.tagName.toLowerCase() !== 'body') return false;
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0.1;
        };

        for (const c of candidates) {
          if (!c || !c.value) continue;
          if (c.strategy === 'css-path' || c.strategy === 'id' || c.strategy === 'attribute') {
            try {
              const el = document.querySelector(c.value);
              if (el && visible(el)) return true;
            } catch {}
          } else if (c.strategy === 'xpath') {
            try {
              const res = document.evaluate(c.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
              const el = res.singleNodeValue;
              if (el && visible(el)) return true;
            } catch {}
          }
        }
        return false;
      }, targetCandidates).catch(() => false);

      if (hasTarget) {
        return true;
      }
    }

    // 5. Check for genuine authenticated DOM indicators (Logout button, User profile avatar)
    const hasAuthIndicator = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        if (el.offsetParent === null && el.tagName.toLowerCase() !== 'body') return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0.1;
      };

      // Genuine logout links or buttons
      const linksAndButtons = Array.from(document.querySelectorAll('a, button'));
      const hasLogout = linksAndButtons.some(el => {
        if (!isVisible(el)) return false;
        const href = (el.getAttribute('href') || '').toLowerCase();
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').toLowerCase().trim();
        return href.includes('logout') || href.includes('signout') || /^(log ?out|sign ?out)$/i.test(text);
      });
      if (hasLogout) return true;

      // User profile / avatar elements
      const profile = document.querySelector('.user-avatar, .user-profile, .app-header .user-info, [aria-label*="Profile" i], [aria-label*="Account" i]');
      if (profile && isVisible(profile)) return true;

      return false;
    }).catch(() => false);

    if (hasAuthIndicator) {
      return true;
    }

    // 6. Check for authenticated URL routes (dashboard, my-reports, invoices, workspace, app, etc.)
    // If on a dedicated post-login application route with no login form or login button, consider authenticated
    const isAuthenticatedUrl = /\/(dashboard|my-reports|reports|invoices|workspace|overview)\b/i.test(currentUrl) ||
      /#\/(dashboard|my-reports|reports|invoices|workspace|overview)/i.test(currentUrl);

    if (isAuthenticatedUrl && !isLoginUrl && !hasLoginForm) {
      return true;
    }

    return false;
  } catch (err) {
    return false;
  }
}

module.exports = {
  isLoginAction,
  detectLoginSequence,
  isSessionAuthenticated
};
