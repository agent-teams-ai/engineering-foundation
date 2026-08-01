import type { CalendarClock } from "../../../application/ports/calendar-clock.js";

export class SystemCalendarClock implements CalendarClock {
  today(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
