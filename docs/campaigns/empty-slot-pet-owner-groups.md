# Empty Slot Campaign: Major-City Pet Owner Groups

## Campaign goal

Find and join relevant Facebook groups for pet owners in major U.S. cities so Empty Slot can later reach pet owners with appointment availability messaging.

## Actor

All actions must be performed as:

```txt
Empty Slot
```

Do not join or post as Jack personally.

## Audience

Target:

- pet owners
- dog owners
- cat owners
- local pet communities
- city-specific pet parent groups
- local neighborhood pet discussion groups

## Exclusions

Do **not** target for this campaign:

- lost-pet groups
- missing-pet groups
- rescue/adoption groups
- animal shelter groups
- rehoming groups
- breeder/sales groups
- generic spam buy/sell groups

If a group mixes general pet ownership with occasional lost-pet posts, judge by the group’s primary purpose. If primary purpose is lost/missing pets, skip it.

## Current 30 search targets

| # | Search query |
|---:|---|
| 1 | New York City pet owners |
| 2 | Los Angeles pet owners |
| 3 | Chicago pet owners |
| 4 | Houston pet owners |
| 5 | Phoenix pet owners |
| 6 | Philadelphia pet owners |
| 7 | San Antonio pet owners |
| 8 | San Diego pet owners |
| 9 | Dallas pet owners |
| 10 | San Jose pet owners |
| 11 | Austin pet owners |
| 12 | Jacksonville pet owners |
| 13 | Fort Worth pet owners |
| 14 | Columbus pet owners |
| 15 | Charlotte pet owners |
| 16 | Indianapolis pet owners |
| 17 | San Francisco pet owners |
| 18 | Seattle pet owners |
| 19 | Denver pet owners |
| 20 | Washington DC pet owners |
| 21 | Boston pet owners |
| 22 | Miami pet owners |
| 23 | Atlanta pet owners |
| 24 | Tampa pet owners |
| 25 | Orlando pet owners |
| 26 | Nashville pet owners |
| 27 | Portland pet owners |
| 28 | Las Vegas pet owners |
| 29 | Minneapolis pet owners |
| 30 | Detroit pet owners |

## Join rules

1. Join-only first; do not post during the discovery/join phase.
2. Prefer groups with clear local city relevance.
3. Prefer active groups with normal discussion and low spam.
4. Skip groups requiring sensitive/personal questions.
5. Skip groups where the join form asks for promises that conflict with campaign intent.
6. Keep first-day join volume low: 5-10 groups maximum.

## Quality scoring

| Signal | Good | Bad |
|---|---|---|
| Audience | pet owners/pet parents | lost pets, shelters, breeders, spam |
| Location | target city/metro | unclear/global |
| Activity | recent member discussion | dead group or bot posts |
| Rules | allows helpful local resources | bans businesses/resources entirely |
| Actor fit | Empty Slot can participate naturally | would look irrelevant or intrusive |

## Status labels

Use these in local logs or Supabase results:

- `candidate`
- `skipped_wrong_audience`
- `skipped_lost_pet`
- `skipped_low_quality`
- `join_requested`
- `joined`
- `rejected_or_not_approved`
- `needs_review`

## Posting rule

No posting until:

- group joins are accepted,
- actor is proven as Empty Slot,
- group rules are reviewed,
- Jack approves first copy.
