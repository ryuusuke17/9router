let interval = null;

export function startQuotaWatchdog() {
  if (interval) return;
  interval = setInterval(tick, 300_000);
  if (interval.unref) interval.unref();
}

export function stopQuotaWatchdog() {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

async function tick() {
}
