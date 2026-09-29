import { getLanguage } from './localization';

// "3 hours ago", "yesterday", in the interface language.
export const relativeTime = (time: number): string => {
  const minutes = Math.round((time - Date.now()) / 60000);
  const format = new Intl.RelativeTimeFormat(getLanguage(), { numeric: 'auto' });
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = Math.abs(minutes) < 60 ? [minutes, 'minute']
    : Math.abs(minutes) < 60 * 24 ? [Math.round(minutes / 60), 'hour']
      : Math.abs(minutes) < 60 * 24 * 30 ? [Math.round(minutes / (60 * 24)), 'day']
        : Math.abs(minutes) < 60 * 24 * 365 ? [Math.round(minutes / (60 * 24 * 30)), 'month']
          : [Math.round(minutes / (60 * 24 * 365)), 'year'];
  return format.format(value, unit);
};

// A date and time in full, for tooltips and commit details.
export const fullTime = (time: number): string =>
  new Date(time).toLocaleString(getLanguage(), { dateStyle: 'medium', timeStyle: 'short' });

// A date alone, for columns.
export const shortDate = (time: number): string =>
  new Date(time).toLocaleDateString(getLanguage(), { year: 'numeric', month: 'short', day: 'numeric' });
