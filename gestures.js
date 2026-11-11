// Phone bottom sheets: a grab bar on top, and a downward swipe closes the
// sheet. The swipe starts only when the sheet's content is scrolled to the
// top, so scrolling a long form never closes it by accident.

const CLOSE_FRACTION = 0.25; // dragged past a quarter of the sheet height
const FLICK_SPEED = 0.35; // px/ms: a quick flick closes from a short drag

/** The nearest scrolling box between the touched element and the sheet. */
function scrollerOf(target, sheet) {
  for (let el = target; el && el !== sheet.parentElement; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(style.overflowY)) return el;
    if (el === sheet) break;
  }
  return null;
}

/**
 * @param {HTMLElement} sheet the fixed bottom sheet
 * @param {() => void} close the sheet's normal close (removes it, restores focus)
 * @param {HTMLElement} [backdrop] faded along with the drag
 */
export function swipeToClose(sheet, close, backdrop = null) {
  const grabber = document.createElement('div');
  grabber.className = 'sheet-grabber';
  grabber.setAttribute('aria-hidden', 'true');
  sheet.prepend(grabber);

  let start = null; // { x, y, t } while a swipe may begin
  let dragging = false;
  let dy = 0;

  const reset = (animate) => {
    sheet.style.transition = animate ? 'transform 0.2s ease' : '';
    sheet.style.transform = '';
    if (backdrop) backdrop.style.opacity = '';
    start = null;
    dragging = false;
    dy = 0;
  };

  sheet.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches.length !== 1) return;
      const scroller = scrollerOf(event.target, sheet);
      if (scroller && scroller.scrollTop > 0) return; // let the content scroll
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, t: Date.now() };
      dragging = false;
      dy = 0;
    },
    { passive: true },
  );

  sheet.addEventListener(
    'touchmove',
    (event) => {
      if (!start) return;
      const touch = event.touches[0];
      const down = touch.clientY - start.y;
      if (!dragging) {
        const side = Math.abs(touch.clientX - start.x);
        if (down < -4 || side > Math.abs(down)) {
          start = null; // scrolling up or sideways: not a close gesture
          return;
        }
        if (down < 8) return;
        dragging = true;
        sheet.style.transition = 'none';
      }
      event.preventDefault();
      dy = Math.max(0, down);
      sheet.style.transform = `translateY(${dy}px)`;
      if (backdrop) backdrop.style.opacity = String(Math.max(0, 1 - dy / (sheet.offsetHeight || 1)));
    },
    { passive: false },
  );

  const end = () => {
    if (!dragging) {
      start = null;
      return;
    }
    const speed = dy / Math.max(1, Date.now() - start.t);
    if (dy > sheet.offsetHeight * CLOSE_FRACTION || (speed > FLICK_SPEED && dy > 50)) {
      sheet.style.transition = 'transform 0.18s ease-out';
      sheet.style.transform = 'translateY(100%)';
      start = null;
      dragging = false;
      setTimeout(close, 170);
    } else {
      reset(true);
    }
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', () => reset(true));
}
