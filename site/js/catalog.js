// Discover dates from each chain's movie catalogue, including advance sales.
import { GSC, createProviders, parseGscShowtimes } from './providers.js?v=27';
import { mapLimit } from './aggregator.js?v=27';
import { todayMyt } from './models.js?v=27';

export async function collectCatalogue({ fetch: fetchImpl = globalThis.fetch, parseXml, chains = ['GSC', 'TGV'], region = '', signal, concurrency = 4, onProgress = () => {} } = {}) {
  const providers = createProviders({ fetch: fetchImpl, parseXml });
  const cinemas = [], shows = [], errors = [];
  const today = todayMyt();
  const wanted = c => !region || c.region.toLowerCase().includes(region.toLowerCase());
  let done = 0, total = 0;
  const get = async (url, body) => {
    const timeout = AbortSignal.timeout(20000);
    const res = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  };
  const json = async (url, body) => {
    const data = await (await get(url, body)).json();
    if (data.success === false) throw new Error('Chain returned an unsuccessful response');
    return data.results;
  };
  const run = async (jobs, worker) => {
    total += jobs.length;
    onProgress({ done, total });
    await mapLimit(jobs, concurrency, async job => {
      try { await worker(job); } catch (e) {
        if (signal?.aborted) throw e;
        errors.push(`${job.label}: ${e.message}`);
      } finally { onProgress({ done: ++done, total }); }
    });
  };
  if (chains.includes('GSC')) {
    try {
      const venues = (await providers.GSC.fetchCinemas(signal)).filter(wanted);
      cinemas.push(...venues);
      const xml = parseXml(await (await get(`${GSC.showtimesUrl.replace('getShowTimesByLocation_ParentChild_V2', 'getEpaymentMovie_ParentChild')}?includeChild=true&parent=`)).text());
      const jobs = [];
      for (const movie of xml.getElementsByTagName('parent')) {
        const id = movie.getAttribute('code');
        const dates = [...new Set(Array.from(movie.getElementsByTagName('show'), s => s.getAttribute('opsdate')))].filter(d => d >= today);
        for (const date of dates) jobs.push({ id, date, label: `GSC ${movie.getAttribute('title')} ${date}` });
      }
      await run(jobs, async ({ id, date }) => {
        const url = `${GSC.showtimesUrl.replace('ByLocation', 'ByMovie')}?${new URLSearchParams({ parentid: id, oprndate: date })}`;
        const doc = parseXml(await (await get(url)).text());
        const root = doc.getElementsByTagName('locations')[0];
        if (!root) throw new Error('Missing movie locations');
        for (const location of root.getElementsByTagName('location')) {
          const venue = venues.find(c => c.cinema_id === location.getAttribute('id') && c.hall_group === (location.getAttribute('hallgroup') || ''));
          if (!venue) continue;
          // Adapt the movie-oriented XML to the existing session parser.
          const parent = { getAttribute: key => key === 'title' ? root.getAttribute('parent_title') : key === 'code' ? id : '', getElementsByTagName: key => location.getElementsByTagName(key) };
          const oprn = { getAttribute: () => date, getElementsByTagName: key => key === 'parent' ? [parent] : [] };
          const adapter = { getElementsByTagName: key => key === 'oprn' ? [oprn] : [] };
          shows.push(...parseGscShowtimes('', venue, () => adapter));
        }
      });
    } catch (e) { if (signal?.aborted) throw e; errors.push(`GSC could not load catalogue: ${e.message}`); }
  }
  if (chains.includes('TGV')) {
    try {
      const venues = (await providers.TGV.fetchCinemas(signal)).filter(wanted);
      cinemas.push(...venues);
      const base = 'https://api.tgv.com.my/api';
      const tabs = await json(`${base}/movies/v1/movielist/getmoviepagemovielist`);
      const movies = new Map();
      await run(tabs.movielistinfo.map(t => ({ key: t.key, label: `TGV catalogue ${t.key}` })), async ({ key }) => {
        const list = await json(`${base}/movies/v1/movielist/${key}`);
        for (const m of list.movies || []) movies.set(m.recid, m);
      });
      const venueDays = new Map();
      await run([...movies.values()].map(m => ({ movie: m, label: `TGV dates ${m.name}` })), async ({ movie }) => {
        const dates = await json(`${base}/boxoffice/v1/moviesession_getsessionbusinessdates`, { movieid: movie.recid, location: '' });
        for (const date of dates.businessdates || []) {
          if (date < today) continue;
          const locations = await json(`${base}/boxoffice/v1/moviesession_getmoviecinemas`, { movieid: movie.recid, businessday: date });
          for (const location of locations.locations || []) for (const cinema of location.cinemaids || []) {
            const venue = venues.find(c => c.cinema_id === cinema.cinemaid);
            if (venue) venueDays.set(`${date}|${venue.cinema_id}`, { venue, date, label: `TGV ${venue.name} ${date}` });
          }
        }
      });
      await run([...venueDays.values()], async ({ venue, date }) => shows.push(...await providers.TGV.fetchShowtimes(venue, date, signal)));
    } catch (e) { if (signal?.aborted) throw e; errors.push(`TGV could not load catalogue: ${e.message}`); }
  }
  return { cinemas, showtimes: shows, errors };
}
