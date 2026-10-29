import { summarizeMovies } from './aggregator.js?v=29';

export const isConcert = show => [...(show.genres || []), ...(show.tags || [])].some(label => /\bconcerts?\b/i.test(label));
export const overnightLabel = show => `${show.start.slice(11, 16)}${show.start.slice(0, 10) > show.business_date ? ' +1' : ''}`;
export function screeningLabel(date, today) {
  if (date === today) return 'Showing now';
  return `Next screening: ${new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
}
export function browseMovies(shows, { today, sort = 'shows' }) {
  const movies = summarizeMovies(shows.filter(s => s.business_date >= today));
  for (const movie of movies) movie.nextDate = movie.shows.map(s => s.business_date).sort()[0];
  return movies.sort((a, b) => {
    const title = a.title.localeCompare(b.title);
    if (sort === 'title') return title;
    if (sort === 'shows') return b.showCount - a.showCount || title;
    return a.nextDate.localeCompare(b.nextDate) || title;
  });
}
