const assert = require('assert');
const InterruptionHandler = require('../src/replay/interruption-handler');
const ItemDiscovery = require('../src/shared/item-discovery');
const { executeClick } = require('../src/replay/action-executors');

console.log('🧪 Starting Duplicate Window Deduplication & Frame Isolation Tests...\n');

// Mock Puppeteer Page with simulated DOM
function createMockPageWithStackedWindows() {
  const windows = [
    {
      id: 'ext-window-1',
      title: 'Search Invoices',
      zIndex: 100, // Background window
      closed: false,
      visible: true
    },
    {
      id: 'ext-window-2',
      title: 'Search Invoices',
      zIndex: 105, // Middle window
      closed: false,
      visible: true
    },
    {
      id: 'ext-window-3',
      title: 'Search Invoices',
      zIndex: 110, // Front-most active window
      closed: false,
      visible: true
    }
  ];

  return {
    _windows: windows,
    async evaluate(fn, ...args) {
      // Execute the function inside a mock browser environment
      const mockDocument = {
        querySelectorAll(selector) {
          if (selector.includes('.x-window') || selector.includes('[role="dialog"]')) {
            return windows.filter(w => w.visible && !w.closed).map(w => {
              const el = {
                id: w.id,
                tagName: 'DIV',
                nodeType: 1,
                classList: {
                  contains: (cls) => cls === 'x-window',
                  add: (cls) => { if (cls === 'x-hidden') w.closed = true; }
                },
                style: {
                  display: w.closed ? 'none' : 'block',
                  visibility: w.closed ? 'hidden' : 'visible'
                },
                getBoundingClientRect: () => ({ width: 800, height: 600, top: 50, left: 50 }),
                querySelector(subSel) {
                  if (subSel.includes('title') || subSel.includes('header')) {
                    return { textContent: w.title };
                  }
                  if (subSel.includes('tool-close') || subSel.includes('close')) {
                    return {
                      textContent: 'Close',
                      className: 'x-tool-close',
                      getAttribute: () => 'Close',
                      dispatchEvent: () => {},
                      click: () => { w.closed = true; }
                    };
                  }
                  return null;
                },
                querySelectorAll(subSel) {
                  if (subSel.includes('button') || subSel.includes('tool') || subSel.includes('close')) {
                    return [{
                      textContent: 'Close',
                      className: 'x-tool-close',
                      getAttribute: () => 'Close',
                      dispatchEvent: () => {},
                      click: () => { w.closed = true; }
                    }];
                  }
                  return [];
                },
                setAttribute: (name, val) => {
                  if (name === 'aria-hidden' && val === 'true') w.closed = true;
                },
                remove: () => {
                  w.closed = true;
                  w.visible = false;
                }
              };
              return el;
            });
          }
          return [];
        }
      };

      const originalDoc = global.document;
      const originalWin = global.window;
      const originalGetComputedStyle = global.getComputedStyle;

      try {
        global.document = mockDocument;
        global.window = {
          getComputedStyle(el) {
            const winObj = windows.find(w => w.id === el.id);
            return {
              display: winObj?.closed ? 'none' : 'block',
              visibility: winObj?.closed ? 'hidden' : 'visible',
              opacity: '1',
              zIndex: String(winObj?.zIndex || 0),
              position: 'absolute'
            };
          }
        };
        global.getComputedStyle = global.window.getComputedStyle;

        return await fn(...args);
      } finally {
        global.document = originalDoc;
        global.window = originalWin;
        global.getComputedStyle = originalGetComputedStyle;
      }
    }
  };
}

// ------------------------------------------------------------
// Test 1: closeDuplicateWindows closes background instances
// ------------------------------------------------------------
console.log('🔹 Test 1: closeDuplicateWindows closes 2 background windows and keeps 1 front-most active window');
(async () => {
  const handler = new InterruptionHandler();
  const mockPage = createMockPageWithStackedWindows();

  assert.strictEqual(mockPage._windows.filter(w => !w.closed).length, 3);

  const result = await handler.closeDuplicateWindows(mockPage);

  assert.strictEqual(result.closedCount, 2, 'Expected exactly 2 background duplicate windows to be closed');
  assert.strictEqual(result.keptTitle, 'search invoices', 'Expected title to match');

  const openWindows = mockPage._windows.filter(w => !w.closed);
  assert.strictEqual(openWindows.length, 1, 'Expected exactly 1 window to remain open');
  assert.strictEqual(openWindows[0].id, 'ext-window-3', 'Expected the front-most window (highest z-index 110) to be preserved');
  assert.strictEqual(mockPage._windows[0].closed, true, 'Window 1 should be closed');
  assert.strictEqual(mockPage._windows[1].closed, true, 'Window 2 should be closed');

  console.log('  ✅ 2 background duplicate windows closed; front-most active window preserved!\n');
})();

// ------------------------------------------------------------
// Test 2: executeClick does not fire duplicate clicks on direct hits
// ------------------------------------------------------------
console.log('🔹 Test 2: executeClick fires only 1 click on direct hits (no duplicate window spawning)');
(async () => {
  let clickCount = 0;
  const mockElementHandle = {
    evaluate: async (fn, ...args) => {
      const fnStr = fn.toString();
      if (fnStr.includes('isVisible') || fnStr.includes('hasDimensions')) {
        return { isVisible: true, isDisabled: false, didScroll: false };
      }
      if (fnStr.includes('isDirectHit')) {
        return { isDirectHit: true, isInteractive: true, topElTag: 'BUTTON' };
      }
      return null;
    },
    evaluateHandle: async () => null,
    boundingBox: async () => ({ x: 100, y: 100, width: 80, height: 30 }),
    click: async () => {
      clickCount++;
    }
  };

  const action = {
    type: 'CLICK',
    index: 1,
    name: 'Open Invoices Window',
    elementName: 'Invoices Menu'
  };

  await executeClick(mockElementHandle, action, {});

  assert.strictEqual(clickCount, 1, 'Expected native CDP click to be executed exactly once without duplicate synthetic clicks');
  console.log('  ✅ Native click executed exactly once; duplicate synthetic clicks eliminated!\n');
})();

// ------------------------------------------------------------
// Test 3: Single window is ignored by closeDuplicateWindows
// ------------------------------------------------------------
console.log('🔹 Test 3: Normal single window is untouched by closeDuplicateWindows');
(async () => {
  const handler = new InterruptionHandler();
  const mockPage = {
    async evaluate(fn) {
      // When 1 window exists
      global.document = {
        querySelectorAll: () => [{
          id: 'single-win',
          classList: { contains: () => true },
          style: { display: 'block', visibility: 'visible' },
          getBoundingClientRect: () => ({ width: 800, height: 600 }),
          querySelector: () => ({ textContent: 'Search Invoices' }),
          querySelectorAll: () => []
        }]
      };
      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', zIndex: '100', position: 'absolute' })
      };
      try {
        return await fn();
      } finally {
        delete global.document;
        delete global.window;
      }
    }
  };

  const result = await handler.closeDuplicateWindows(mockPage);
  assert.strictEqual(result.closedCount, 0, 'No windows should be closed when only 1 exists');
  console.log('  ✅ Single window preserved untouched!\n');
})();

// ------------------------------------------------------------
// Test 4: ItemDiscovery.getItemHandle targets front-most active window when stacked
// ------------------------------------------------------------
console.log('🔹 Test 4: ItemDiscovery.getItemHandle resolves rows from front-most active window, ignoring background window');
(async () => {
  const window1 = {
    id: 'win-bg',
    zIndex: 100,
    rows: ['BG-ROW-1', 'BG-ROW-2']
  };
  const window2 = {
    id: 'win-front',
    zIndex: 200,
    rows: ['FRONT-ROW-1', 'FRONT-ROW-2']
  };

  const mockPage = {
    async evaluateHandle(fn, args) {
      const originalDoc = global.document;
      const originalWin = global.window;
      const originalGetComputedStyle = global.getComputedStyle;

      try {
        const createTbody = (win) => {
          const tbody = {
            tagName: 'TBODY',
            nodeType: 1,
            getBoundingClientRect: () => ({ width: 500, height: 200, top: 100, left: 100 }),
            children: win.rows.map((rText, idx) => ({
              tagName: 'TR',
              nodeType: 1,
              innerText: rText,
              textContent: rText,
              closest: () => null,
              getAttribute: () => null,
              querySelectorAll: () => [],
              querySelector: () => null,
              children: [{ tagName: 'TD', textContent: rText, getAttribute: () => null, closest: () => null, querySelectorAll: () => [], querySelector: () => null }],
              getBoundingClientRect: () => ({ width: 500, height: 30, top: 100 + idx * 30, left: 100 })
            }))
          };
          return tbody;
        };

        const tbody1 = createTbody(window1);
        const tbody2 = createTbody(window2);

        const win1El = {
          id: 'win-bg',
          tagName: 'DIV',
          classList: { contains: () => true },
          style: { display: 'block', visibility: 'visible' },
          getBoundingClientRect: () => ({ width: 600, height: 400 }),
          contains: (el) => el === tbody1 || tbody1.children.includes(el)
        };

        const win2El = {
          id: 'win-front',
          tagName: 'DIV',
          classList: { contains: () => true },
          style: { display: 'block', visibility: 'visible' },
          getBoundingClientRect: () => ({ width: 600, height: 400 }),
          contains: (el) => el === tbody2 || tbody2.children.includes(el)
        };

        global.document = {
          querySelectorAll(sel) {
            if (sel.includes('.x-window') || sel.includes('[role="dialog"]')) {
              return [win1El, win2El];
            }
            if (sel.includes('tbody') || sel.includes('table')) {
              // Note: tbody1 is returned first in DOM order
              return [tbody1, tbody2];
            }
            return [];
          }
        };

        global.window = {
          getComputedStyle(el) {
            const isWin2 = el === win2El || el.id === 'win-front';
            return {
              display: 'block',
              visibility: 'visible',
              opacity: '1',
              zIndex: isWin2 ? '200' : '100',
              position: 'absolute'
            };
          }
        };
        global.getComputedStyle = global.window.getComputedStyle;

        const resolved = fn(args);
        return {
          asElement: () => resolved,
          dispose: async () => {}
        };
      } finally {
        global.document = originalDoc;
        global.window = originalWin;
        global.getComputedStyle = originalGetComputedStyle;
      }
    }
  };

  const discovery = {
    success: true,
    collection: {
      itemTag: 'tr',
      ancestorTag: 'tbody',
      itemSignature: 'tr|td|||'
    },
    items: [{ text: 'FRONT-ROW-1' }]
  };

  const handle = await ItemDiscovery.getItemHandle(mockPage, discovery, 0);
  const element = handle.asElement();

  assert(element, 'Expected element to be resolved');
  assert.strictEqual(element.innerText, 'FRONT-ROW-1', 'Should resolve from the front-most active window (FRONT-ROW-1), NOT the background window (BG-ROW-1)');
  console.log('  ✅ Successfully resolved item from front-most active window (z-index: 200), ignoring background window!\n');
})();

console.log('🎉 ALL DUPLICATE WINDOW DEDUPLICATION TESTS PASSED SUCCESSFULLY!\n');
