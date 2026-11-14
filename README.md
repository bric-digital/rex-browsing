# rex-browsing

REX module that records every http and https visit after install, in the same structure as a `rex-history-visit`, so browsing before and after the install date lines up in one analysis.

**Current release: none yet for rex-browsing.** The last release under the old name, rex-visit-graph, was `v2.0.0`. Once `v3.0.0` is cut, pin it:

```json
"@bric/rex-browsing": "github:bric-digital/rex-browsing#v3.0.0"
```

`package.json` on `main` carries a `-dev` version between releases (`3.0.0-dev` means not yet 3.0.0), so the repo never names a release that was not cut. Releases and what the numbers mean: [RELEASING.md](RELEASING.md).

## Why

Researchers compare what participants did before installing a REX extension with what they do after. rex-history reads Chrome history, the only source for browsing before install. After install a study can also record each visit as it happens, with the redirect steps history search omits and the link to its tab and page-events session, in the same structure as a `rex-history-visit`, so one analysis spans the install date. rex-browsing is that live record.

Chrome also keeps redirect steps out of history search results, while the landing page still points at one through its referring visit id. `chrome.history.onVisited` fires for those steps, so recording from it means a landing page's `referring_visit_id` names a record that exists.

Studies opt in: the module is off until configuration enables it. It does no redaction yet; redaction belongs to rex-content-processing.

## What it records

Every http and https visit Chrome reports. Nothing narrows or drops one. The module depends on no other REX module to record; rex-core supplies configuration and the participant identifier.

### `rex-browsing-visit`

Fields shared with `rex-history-visit`, with the same names and meanings:

| Field | Meaning |
|-------|---------|
| `url`, `recorded_url` | The visited address, in full. Both hold the same value |
| `domain` | Registered domain of the address's host (public suffix list), `not available` when there is none |
| `title` | The page title, read when the record is emitted; empty when Chrome holds no history item for the address |
| `visit_time`, `date` | When the visit happened, in milliseconds since the epoch. Both hold the same value |
| `transition_type` | Chrome's transition type for the visit |
| `is_local` | Whether the visit happened on this device |
| `visit_id`, `referring_visit_id` | Chrome's visit id and the id of the visit that led to it, `0` when none |
| `history_item_id`, `last_visit_time`, `visit_count`, `typed_count` | From the history item for the address, read when the record is emitted |

The item-level fields come from the history item whose address matches exactly. A redirect step has none, so those fields are absent from its record and `title` is empty.

There are no list fields: no `category`, no allow or block list results.

Tab fields, present when the visit is linked to a tab (see below): `tab_id`, `window_id`, `session_id`, `page_events_url_shown_at`.

### `rex-browsing-opener`

Chrome records no referrer across a tab boundary, so a result opened in a new tab arrives with referring visit id `0`. With `tab_opener_edges` on, the first visit in a new tab is attributed to the page that opened it, from `chrome.tabs`. Fields: `visit_id`, `referring_visit_id` (the opener page's visit), `visit_time`, `date`, `transition`, `url`. In a redirect chain the edge attaches to the chain's first visit. Needs the `tabs` permission in the host extension.

### `rex-browsing-page`

With `internal_pages` on, the browser's own pages (`chrome://`, `chrome-untrusted://`, `edge://`), which Chrome keeps out of history, are recorded from `chrome.tabs`. Fields: `visit_time`, `date`, `tab_id`, `url`. There are no visit ids. These addresses can carry text the participant typed, such as a history search. Needs the `tabs` permission.

## Tab link

A visit is linked to the tab it happened in from a `rex-page-events` url-active record. The host extension must include rex-page-events, which sends the module a `pageUrlActive` message for each record. The module matches a record to a visit when the address is the same and the record's `url_shown_at` is within `page_events_link_tolerance_ms` of the visit time; the newest matching record wins. Either may arrive first. Set the tolerance to `0` to turn linking off. Without rex-page-events, visits are recorded without tab fields.

## Lifecycle

- **Before configuration is read.** Visits are held in `chrome.storage.local`, because a visit not captured while it happens cannot be recovered. When configuration arrives, the module keeps them if `enabled` is true and discards them if not.
- **While disabled.** The default. The module holds no listeners and emits nothing. Anything it holds is discarded.
- **Before an identifier exists.** Records are held, not emitted, so nothing goes out unattributed. They are emitted once rex-core's `getIdentifier` returns one.
- **Age.** A record never emitted is discarded after `max_record_age_days`, whether or not the module is enabled or has an identifier.
- **Emission.** The host sends `triggerBrowsingDrain`. Each record is dispatched, then deleted. A worker killed between the two re-emits it on the next drain; a duplicate can be removed in analysis, a loss cannot.

## Messages

| Message | Direction | Effect |
|---------|-----------|--------|
| `triggerBrowsingDrain` | host to module | Emits stored records now. The response is the number of points emitted, or `0` when nothing was emitted (disabled, no identifier, a drain already running, or an error) |
| `pageUrlActive` | rex-page-events to module | Carries a url-active record for the tab link. The response is `{ "success": true }` once stored |

## Configuration

The module reads the `browsing` section of the backend config. Every field has a default, so a study needs no block at all to leave the module off, and needs only `"enabled": true` to turn it on.

The module declares the same settings in code, via `configurationDetails()` in `src/service-worker.mts`. A test asserts that declaration covers every setting the module reads.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Turns the module on. Off, it captures and emits nothing and discards what it holds |
| `page_events_link_tolerance_ms` | number | `5000` | Match window for linking a visit to a url-active record. `0` disables linking |
| `tab_opener_edges` | boolean | `true` | Record `rex-browsing-opener` points |
| `max_opener_visits` | number | `25000` | Ceiling on an opener page's visit count. Above it the page is not looked up, so tabs it opens get no opener record. `getVisits()` cannot be bounded and costs about a second on a page that re-records a visit every few seconds, charged per new tab. `0` removes the ceiling |
| `internal_pages` | boolean | `false` | Record `rex-browsing-page` points |
| `max_record_age_days` | number | `7` | Days after which a record never emitted is discarded |

Example:

```json
{
  "browsing": {
    "enabled": true,
    "internal_pages": false,
    "max_record_age_days": 7
  }
}
```

## How it works

| File | Responsibility |
|------|----------------|
| `service-worker.mts` | The REX module: listeners, configuration, drain, message handling |
| `visit-lookup.mts` | Turns a URL into its newest visit via `chrome.history.getVisits()` |
| `visit-store.mts` | Holds recorded visits until they can be emitted |
| `history-item.mts` | Reads the history-item fields and computes `domain` |
| `tab-link.mts` | Links visits to tabs from url-active records |
| `edge-store.mts` | One key per record in `chrome.storage.local`, under a prefix per kind of record |
| `tab-opener.mts` | Attributes a new tab's first visit to the page that opened it |
| `internal-pages.mts` | Records the browser's own pages from `chrome.tabs` |

Capture and emission are separate because they answer to different constraints. `onVisited` fires once, so the listener is registered in `setup()` before configuration is read. Points may not be dispatched before configuration and an identifier exist, so emission waits for the drain. The store between them lets both hold.

## Adopting v3 from rex-visit-graph v2

v3 changes what the module emits and what it is called. Every item below needs an edit in the host extension, the server config, or the analysis.

Renames:

| v2 | v3 |
|----|----|
| package `@bric/rex-visit-graph` | `@bric/rex-browsing` |
| config section `visit_graph` | `browsing` |
| message `triggerVisitGraphDrain` | `triggerBrowsingDrain` |
| point `rex-visit-graph-hop` | `rex-browsing-visit` |
| point `rex-visit-graph-opener` | `rex-browsing-opener` |
| point `rex-visit-graph-page` | `rex-browsing-page` |
| log prefix `[rex-visit-graph]` | `[rex-browsing]` |
| storage prefixes `rexVisitGraph...` | `rexBrowsing...` |

Behavior changes:

- The module is off by default. v2 defaulted `enabled` to `true`.
- It records every http and https visit, not only redirect hops, in the `rex-history-visit` structure. v2 hop points carried only ids and a redacted address.
- Visits are held until configuration and an identifier exist.
- Records past `max_record_age_days` are discarded in every state.
- New: tab link fields and `page_events_link_tolerance_ms`.

Removed settings: `capture_scope`, `capture_rules`, `capture_block_lists`, `capture_allow_lists`, `schemes`, `url_detail`, `debug`, `redaction`, `max_hop_age_days`. The last is replaced by `max_record_age_days`. The `capture_rule` field is no longer emitted. Without capture rules, `schemes` and `url_detail`, the module neither narrows what it records nor redacts addresses; redaction belongs to rex-content-processing.

The module no longer reads rex-history's lists or consults whether rex-history can see a visit, so a visit may appear in both modules' data. `visit_id` is the join key between them.
