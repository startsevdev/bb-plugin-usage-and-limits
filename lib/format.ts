// Labels for models, cron schedules and counts.

/** "claude-opus-5-5" → "Opus 5.5". */
export function modelLabel(model: string): string {
  const match = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (match === null) return model;
  const [, family, major, minor] = match;
  const name = family!.charAt(0).toUpperCase() + family!.slice(1);
  return minor === undefined || minor.length > 2 ? `${name} ${major}` : `${name} ${major}.${minor}`;
}

const WEEKDAYS: Record<string, string> = {
  "0": "Sundays",
  "1": "Mondays",
  "2": "Tuesdays",
  "3": "Wednesdays",
  "4": "Thursdays",
  "5": "Fridays",
  "6": "Saturdays",
  "7": "Sundays",
  "1-5": "weekdays",
  "6,0": "weekends",
  "0,6": "weekends",
};

/** Common cron shapes in words; anything else is "scheduled". */
export function humanizeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "scheduled";
  const [minute, hour, dayOfMonth, month, weekday] = parts as [string, string, string, string, string];
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === "*") return `every ${everyMinutes[1]} min`;
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (/^\d+$/.test(minute) && everyHours) return `every ${everyHours[1]}h`;
  if (/^\d+$/.test(minute) && hour === "*") return "hourly";
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== "*") return "scheduled";
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (dayOfMonth !== "*") return /^\d+$/.test(dayOfMonth) ? `monthly on day ${dayOfMonth} ${time}` : "scheduled";
  if (weekday === "*") return `daily ${time}`;
  const days = WEEKDAYS[weekday];
  return days === undefined ? "scheduled" : `${days} ${time}`;
}

/** count(3, "subagent") → "3 subagents". */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
