# rex-browsing

REX module that records every http and https visit after install, in the same structure as a `rex-history-visit`, so browsing before and after the install date lines up in one analysis.

**Current release: none yet for rex-browsing.** The last release under the old name, rex-visit-graph, was `v2.0.0`. Once `v3.0.0` is cut, pin it:

```json
"@bric/rex-browsing": "github:bric-digital/rex-browsing#v3.0.0"
```

Import it once in the host extension's service worker, which registers the module with rex-core:

```js
import '@bric/rex-browsing/service-worker'
```

The host extension needs the `history` permission, and `storage`, which rex-core already requires. `tabs` is needed only for `tab_opener_edges` and `internal_pages` (see below).

`package.json` on `main` carries a `-dev` version between releases (`3.0.0-dev` means not yet 3.0.0), so the repo never names a release that was not cut. Releases and what the numbers mean: [RELEASING.md](RELEASING.md).

## Why

Researchers compare what participants did before installing a REX extension with what they do after. rex-history reads Chrome history, the only source for browsing before install. After install a study can also record each visit as it happens, with the redirect steps history search omits and the link to its tab and page-events session, in the same structure as a `rex-history-visit`, so one analysis spans the install date. rex-browsing is that live record.

Chrome also keeps redirect steps out of history search results, while the landing page still points at one through its referring visit id. `chrome.history.onVisited` fires for those steps, so recording from it means a landing page's `referring_visit_id` names a record that exists.

Studies opt in: the module is off until configuration enables it. It does no redaction yet; redaction belongs to rex-content-processing.

## What it records

Every http and https visit Chrome reports. Nothing narrows one: no list, rule or scope decides what is kept. Two visits to one address are two records, however close together. A visit whose ids cannot be had is still recorded, without them (see `ids_unavailable` below). The module depends on no other REX module to record; rex-core supplies configuration and the participant identifier.

### `rex-browsing-visit`

Fields shared with `rex-history-visit`, with the same names and meanings:

| Field | Meaning |
|-------|---------|
| `url` | The visited address, in full. `rex-history-visit` also carries `recorded_url`, always equal to its `url`; this record leaves it out |
| `domain` | Registered domain of the address's host (public suffix list), `not available` when there is none |
| `title` | The page title, read when the record is emitted; empty when Chrome holds no history item for the address |
| `visit_time`, `date` | When the visit happened, in milliseconds since the epoch. Both hold the same value |
| `transition_type` | Chrome's transition type for the visit |
| `is_local` | Whether the visit happened on this device |
| `visit_id`, `referring_visit_id` | Chrome's visit id and the id of the visit that led to it, `0` when none. Absent when `ids_unavailable` is present |
| `history_item_id`, `last_visit_time`, `visit_count`, `typed_count` | From the history item for the address, read when the record is emitted |

The item-level fields come from the history item whose address matches exactly. A redirect step has none, so those fields are absent from its record and `title` is empty.

There are no list fields: no `category`, no allow or block list results.

Tab fields, present when the visit is linked to a tab (see below): `tab_id`, `window_id`, `session_id`, `page_events_url_shown_at`. A link can be partial: `page_events_url_shown_at` is always present, and each of the other three is present only when the url-active record carried it.

`ids_unavailable` is present only on a visit recorded without its ids, with one of two values:

- `over_ceiling`: the address has more visits than `max_visits_per_url`, so the module did not look it up.
- `lookup_failed`: Chrome's visit lookup returned nothing or failed, for example because the address was deleted from history within milliseconds.

Such a record has `url`, `domain`, `title`, `visit_time` and `date`, plus tab fields when linked. It has no `visit_id`, `referring_visit_id`, `transition_type` or `is_local`. `title` and the history-item fields are read when the record is emitted, as for any visit; when Chrome holds no history item for the address, the history-item fields are absent and `title` is the one `onVisited` reported. Analysis can count the visit, place it in time and group it by address, domain or tab. It cannot join it to a `rex-history-visit` by `visit_id`, follow its referral chain, or tell redirect steps from landings. Two such visits to one address at different times are two records; the same visit emitted twice (see Lifecycle) has no `visit_id` to match on, so match on `url` and `visit_time`.

### `rex-browsing-visit-ceiling-exceeded`

At each drain, one `pdk-app-event` per address that was recorded over the ceiling in that drain, with `event_name` `rex-browsing-visit-ceiling-exceeded` and `event_details`: `domain`, `visit_count` (Chrome's count for the address, absent when Chrome holds no history item for it), `ceiling` (the one in force when the earliest of those visits was recorded), `visits_in_drain` and `date`. It tells the researcher a participant's profile has an abnormally revisited page, usually one that refreshes itself.

### `rex-browsing-opener`

Chrome records no referrer across a tab boundary, so a result opened in a new tab arrives with referring visit id `0`. With `tab_opener_edges` on, the first visit in a new tab is attributed to the page that opened it, from `chrome.tabs`. Fields: `visit_id`, `referring_visit_id` (the opener page's visit), `visit_time`, `date`, `transition`, `url`. In a redirect chain the edge attaches to the chain's first visit. The `visit_id` can name a visit whose `rex-browsing-visit` was recorded without ids, so no visit record carries it; join such an opener record to its visit by `url` and `visit_time`. Needs the `tabs` permission in the host extension.

### `rex-browsing-page`

With `internal_pages` on, the browser's own pages (`chrome://`, `chrome-untrusted://`, `edge://`), which Chrome keeps out of history, are recorded from `chrome.tabs`. Fields: `visit_time`, `date`, `tab_id`, `url`. There are no visit ids. These addresses can carry text the participant typed, such as a history search. Needs the `tabs` permission.

## Tab link

A visit is linked to the tab it happened in from a `rex-page-events` url-active record. The host extension must include rex-page-events, which sends the module a `pageUrlActive` message for each record. A record needs a string `url` and a numeric `url_shown_at`; anything else is ignored. `tab_id`, `window_id` and `session_id` are copied when present, and one log line is written when any is missing, so a visit can carry a partial link. The module matches a record to a visit when the address is the same and the record's `url_shown_at` is within `page_events_link_tolerance_ms` of the visit time. When several records match one visit, they are merged into one tab's link: the tab is the `tab_id` of the newest record that has one, only records from that tab (and the visit's existing link, when it is the same tab) supply the tab fields, each taking its newest present value, and `page_events_url_shown_at` is the newest record's, including a record that has no `tab_id`. A tab field of the wrong type (a `tab_id` or `window_id` that is not a number, a `session_id` that is not a string) counts as missing. Either may arrive first. Set the tolerance to `0` to turn linking off. Without rex-page-events, visits are recorded without tab fields.

## Lifecycle

- **Before configuration is read.** Visits are held in `chrome.storage.local`, because a visit not captured while it happens cannot be recovered. When configuration arrives, the module keeps them if `enabled` is true and discards them if not.
- **While disabled.** The default. The module holds no listeners and emits nothing. Anything it holds is discarded.
- **Before an identifier exists.** Records are held, not emitted, so nothing goes out unattributed. They are emitted once rex-core's `getIdentifier` returns one.
- **Age.** A record never emitted is discarded at the next drain after it passes `max_record_age_days`, whether or not the module is enabled or has an identifier.
- **Emission.** The host sends `triggerBrowsingDrain`. Each record is dispatched, then deleted. A worker killed between the two re-emits it on the next drain; a duplicate can be removed in analysis, a loss cannot. A visit can also be emitted twice when its tab link lands during a drain: the second copy carries the tab fields. Duplicates share `visit_id`, and the linked copy is the fuller one.

## Messages

| Message | Direction | Effect |
|---------|-----------|--------|
| `triggerBrowsingDrain` | host to module | Emits stored records now. The response is the number of points emitted, or `0` when nothing was emitted (disabled, no identifier, a drain already running, or an error) |
| `pageUrlActive` | rex-page-events to module | Carries a url-active record for the tab link. The response is `{ "success": true }` once stored, or `{ "success": false }` when storing fails. A malformed record, or any record while the module is disabled, is ignored and gets no response from this module |

## Configuration

The module reads the `browsing` section of the backend config. Every field has a default, so a study needs no block at all to leave the module off, and needs only `"enabled": true` to turn it on.

The module declares the same settings in code, via `configurationDetails()` in `src/service-worker.mts`. A test asserts that declaration covers every setting the module reads.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Turns the module on. Off, it captures and emits nothing and discards what it holds |
| `page_events_link_tolerance_ms` | number | `5000` | Match window for linking a visit to a url-active record. `0` disables linking |
| `tab_opener_edges` | boolean | `true` | Record `rex-browsing-opener` points |
| `max_visits_per_url` | number | `10000` | Ceiling on an address's visit count. Above it the address is not looked up: its visits are recorded without ids (`ids_unavailable: over_ceiling`), each drain emits one `rex-browsing-visit-ceiling-exceeded` event for it, and new tabs it opens or that land on it get no opener record. `getVisits()` cannot be bounded and costs about a second on a page that re-records a visit every few seconds. `0` removes the ceiling |
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

## Depends on

`@bric/rex-types` for the `RexVisitRecord` type that `rex-browsing-visit` and `rex-history-visit` share. `package.json` pins it to a commit on a rex-types branch until that branch's pull request merges. Switch the pin back to `github:bric-digital/rex-types` before tagging v3.0.0.

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
- New: `max_visits_per_url` (default `10000`), which bounds the visits recorded with ids per address. Above it, and when the lookup fails, visits are recorded without ids and carry `ids_unavailable`. Analysis that assumes every `rex-browsing-visit` has a `visit_id` must handle the absence.
- New: the `rex-browsing-visit-ceiling-exceeded` event.
- Unsent v2 records under `rexVisitGraphHop:` are not read by v3 and are never emitted. Drain v2 before upgrading.

Removed settings: `max_opener_visits`, replaced by `max_visits_per_url`, which also bounds the opener lookup, with a lower default. A study that set `max_opener_visits` must set `max_visits_per_url` instead. Also removed: `capture_scope`, `capture_rules`, `capture_block_lists`, `capture_allow_lists`, `schemes`, `url_detail`, `debug`, `redaction`, `max_hop_age_days`. The last is replaced by `max_record_age_days`. The `capture_rule` field is no longer emitted. Without capture rules, `schemes` and `url_detail`, the module neither narrows what it records nor redacts addresses; redaction belongs to rex-content-processing.

The module no longer reads rex-history's lists or consults whether rex-history can see a visit, so a visit may appear in both modules' data. `visit_id` is the join key between them.
