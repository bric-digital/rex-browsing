/**
 * The history-item fields a `rex-history-visit` carries, read for a recorded
 * visit so both modules emit them with the same names and meanings.
 */

import psl from 'psl'

export interface HistoryItemFields {
  history_item_id: string;
  title: string;
  last_visit_time: number;
  visit_count: number;
  typed_count: number;
}

/**
 * The fields of the history item whose URL equals this one exactly, or null
 * when Chrome holds none: a redirect step search does not return, or a URL
 * deleted since the visit.
 */
export async function historyItemFields(url: string): Promise<HistoryItemFields | null> {
  try {
    const items = await chrome.history.search({ text: url, startTime: 0, maxResults: 100 })
    const item = items.find((candidate) => candidate.url === url)

    if (item === undefined) {
      return null
    }

    return {
      history_item_id: item.id,
      title: item.title ?? '',
      last_visit_time: item.lastVisitTime ?? 0,
      visit_count: item.visitCount ?? 0,
      typed_count: item.typedCount ?? 0
    }
  } catch (error) {
    console.warn('[rex-browsing] history item lookup failed:', error)
    return null
  }
}

/** The psl registered domain of the URL's host, computed as rex-history does. */
export function registeredDomain(url: string): string {
  try {
    const parsed = psl.parse(new URL(url).hostname)

    if ('domain' in parsed && parsed.domain) {
      return parsed.domain
    }
  } catch {
    // An unparseable URL has no domain.
  }

  return 'not available'
}
