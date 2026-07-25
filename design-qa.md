# Vishan Solar Final Design QA

- Source visual truth: `work/qa/source-approved.png` (browser capture of the approved 1920 × 6631 full-page screenshot, scaled in its source viewer).
- Implementation capture: `work/qa/implementation-desktop.png`.
- Mobile capture: `work/qa/implementation-mobile-390.png`.
- Combined comparison: `work/qa/source-vs-implementation.png`.
- Desktop viewport and capture: 1519 × 679 CSS px at device scale 1.
- Mobile viewport and capture: 390 × 844 CSS px at device scale 1.
- State: initial landing page with no form data entered.

## Full-view comparison evidence

The approved source is a scaled full-page image while the implementation evidence is a same-window desktop hero capture. The combined comparison therefore uses the source's visible first-viewport composition as the primary fidelity target. Both show the established white navigation, solar-home hero, centered dark-blue headline with gold emphasis, embedded white form at the right, blue/gold CTAs, manufacturer strip, alternating light/deep-blue sections, calculator/financing comparison, map, FAQ, final CTA, and footer.

## Focused region comparison evidence

The desktop hero was checked separately at the normal browser viewport. The message block is centered in the middle grid zone, the form occupies the right grid zone with a safe edge gutter, the house and panels remain prominent, and the four outlined differentiator icons sit beneath the CTAs. The mobile hero was checked at 390 × 844 and across 320, 360, 375, 390, 412, 768, and 1024 px. It preserves centered copy, a two-column differentiator grid, a visible villa/panel image interval, and a usable right-aligned form without horizontal overflow.

## Required fidelity surfaces

- Fonts and typography: Poppins remains the only family; the 800 weight is preloaded for the above-fold headline. Size, weight, line height, gold emphasis, and centered wrapping match the approved hierarchy.
- Spacing and layout rhythm: the hero uses the approved three-zone desktop composition and stacked mobile sequence. Form, CTA, trust-item, and section spacing remain consistent with the existing system.
- Colors and visual tokens: existing navy, blue, amber, soft-blue, white, and green tokens are preserved. The text readability treatment is a soft radial/vertical wash rather than an opaque card or dark overlay.
- Image quality and asset fidelity: the existing responsive WebP solar-home image remains the hero source with high fetch priority. No replacement or synthetic image was introduced. The house, panels, facade, and landscaping remain visible.
- Copy and content: approved hero, financing qualifier, service-area, FAQ, CTA, SEO, and form copy remain intact. No unapproved lender names or claims are present.

## Interaction and accessibility evidence

- Primary hero CTA highlights the existing form, scrolls only when required, and focuses `#fullName`.
- Secondary hero CTA moves to `#calc` and focuses `#billSlider`.
- Empty submit focuses the first invalid field and exposes descriptive field errors without making a network request.
- The form remains the single CRM form; its names and payload keys are unchanged.
- The mobile menu, FAQ ARIA state, form live status, calculator live region, reduced-motion rules, focus styles, labels, and touch-size rules remain present.
- Browser console contained only a Chrome-extension message-channel warning; no application-script error was observed.

## Findings

- No actionable P0, P1, or P2 differences remain.
- P3: the source is available only as a scaled full-page capture in its viewer, so exact pixel comparison of every below-fold section is limited. Repository structure and the approved written specification were used to validate those sections.

## Comparison history

1. Initial implementation capture showed the hero content and form extending beyond a short desktop viewport. Hero spacing and form padding were tightened while preserving the approved hierarchy.
2. Post-fix capture shows the headline, supporting copy, subsidy note, both CTAs, differentiator row, form fields, and submit CTA within the visible hero composition.
3. A full-page mobile capture initially exposed blank areas because reveal preparation hid unobserved sections. The reveal implementation was changed so content is visible by default and only animates when observed.
4. Post-fix responsive checks found no horizontal overflow from 320 px through 1024 px.

## Implementation checklist

- [x] Center desktop and mobile hero messaging.
- [x] Place the form in the right desktop zone and right-align it on mobile.
- [x] Preserve a prominent responsive solar-home image.
- [x] Add four consistent hero differentiator icons.
- [x] Remove lender-logo UI from financing.
- [x] Preserve the CRM payload, endpoint, validation, and analytics events.
- [x] Verify responsive overflow, CTA focus, calculator focus, and form validation.
- [x] Keep content visible by default and honor reduced motion.

**final result: passed**
