# BlockFit NYC — MVP Blueprint

**NYCEDC project concept · 17 November 2026 · Two-day prototype**

## Purpose

Help City staff compare outdoor fitness investments: **which candidate sites address more unmet equipment demand within an available budget, and at what ongoing cost?** Public discovery and requests supply useful information; the primary product is an explainable investment comparison. The prototype supports existing reviews and does not promise savings, agency adoption, or installation approval.

## Three entry points

| Entry point | Minimum capability | Value |
| --- | --- | --- |
| Public | Responsive equipment map/list, category filters, site details, source and verification date; official maintenance-reporting link. No login to browse. | Find specific equipment and understand what is confirmed. |
| Signed-in resident | Request an equipment category near one saved location; optionally suggest a site; view, update or withdraw own requests. Same public interface with additional actions. | Record unmet demand without choosing an installation site. |
| City workspace | Add/edit equipment pins, parks and candidate sites; view demand; compare sites under a budget; export a decision brief. | Review incremental coverage, costs, assumptions and unresolved feasibility together. |

Equipment may belong to a park or stand alone. Existing equipment and proposed sites remain separate records. Public views never reveal resident addresses. Use demonstration accounts and synthetic resident locations initially; staff functions require role-based access.

## Demonstration and economic rules

**Browse → request nearby pull-up bars → staff compare two candidate sites → export the comparison.** Limit the pilot to one NYC neighborhood and three categories: pull-up bars, parallel bars and sit-up benches.

- **Coverage:** Use one configurable straight-line distance threshold, explicitly labeled an approximation—not walking time. Count distinct active requesters for the selected category who lack existing equipment within that threshold and would gain access. Count overlapping coverage once in a site combination.
- **Costs:** Show upfront equipment, installation, site preparation and accessibility costs separately from maintenance and replacement. Compare undiscounted totals over the same editable planning period; identify sources, low/base/high assumptions and missing amounts. Unknown is not zero.
- **Comparison:** Show upfront budget fit, newly covered requesters and total modeled cost per newly covered requester; zero coverage yields “N/A.” Display feasibility as unreviewed, suitable for comparison, or excluded. No automatic approval or arbitrary composite score.
- **Interpretation:** Request counts describe participating residents, not population-wide need or equity. Cost per requester is a comparison measure, not financial ROI. Only compare alternatives with equivalent equipment/service scope; report cost differences without calling them realized savings.

## Data, AI and fit with existing City work

Use a small attributed public-data snapshot plus manually entered equipment, with verification status and dates. Label synthetic demand and illustrative costs throughout; real entries can replace them through the staff interface.

NYCEDC already gathers activity preferences for QueensWay [1]. Community-board budget requests and agency responses are publicly documented [2]. Staff can consult those sources alongside our comparison, attach public project references, and export evidence for their existing review. Vital Parks Explorer already covers broader amenity access [3]; maintenance reports remain with NYC311 [4]. No restricted API, registration-dependent City access or direct integration is required.

**AI:** One staff-triggered, cached explanation of a comparison, grounded in its calculated results and supplied assumptions. It identifies missing inputs and explains trade-offs; deterministic code performs the calculations. Send only public or synthetic inputs. No AI-generated cost estimates or calls per public visitor; comparisons remain usable without AI.

## Delivery boundary and acceptance

**Defer:** photo analysis, repair queues, address verification, multiple household locations, routing, land acquisition/appraisal, citywide optimization and automated City submissions.

**Demo passes when:** a saved request updates coverage; staff can persist an equipment pin and candidate site; changing cost/budget assumptions updates comparisons correctly; overlapping requests are not double-counted; a downloadable brief includes sources, assumptions, limitations and any linked City project. No real resident information is needed.

## Public references

1. [NYCEDC QueensWay Metropolitan Hub — May 2026 community input/design presentation](https://edc.nyc/sites/default/files/2026-05/NYCEDC-QueensWay-MetHub-CB6-Presentation-5-6-26.pdf).
2. [NYC Capital Projects Portal — community-board requests, agency responses and data limitations](https://capitalprojects.nycplanningdigital.com/about).
3. [NYC Parks — Vital Parks Explorer guide](https://www.nycgovparks.org/pagefiles/210/Vital-Parks-Explorer-Guide__689b45079e97a.pdf).
4. [NYC311 — Park Maintenance Complaint](https://portal.311.nyc.gov/article/?kanumber=KA-01060).

*Sources reviewed November 2026. These establish complementary public workflows, not an integration agreement or proof that equivalent internal City tools do not exist.*
