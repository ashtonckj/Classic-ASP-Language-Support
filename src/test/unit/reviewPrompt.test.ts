import * as assert from 'assert';
import {
    afterAnswer, countFormat, FIRST_WAIT_DAYS, FORMATS_NEEDED, initialState, isTimeToAsk,
    LATER_WAIT_DAYS, MAX_ASKS, ratingPage, ReviewState,
} from '../../platform/reviewPrompt';

// The rating request has to stay rare: a week in, after five formats that
// worked, and at most twice ever.
const DAY = 24 * 60 * 60 * 1000;
const formatTimes = (state: ReviewState, n: number) => {
    for (let i = 0; i < n; i++) { state = countFormat(state); }
    return state;
};

describe('review prompt timing', () => {
    const start = 1_000_000;

    it('does not ask in the first week, however much the extension is used', () => {
        const state = formatTimes(initialState(start), 100);
        assert.ok(!isTimeToAsk(state, start + (FIRST_WAIT_DAYS - 1) * DAY));
    });

    it('does not ask before the fifth format, however long it has been installed', () => {
        const state = formatTimes(initialState(start), FORMATS_NEEDED - 1);
        assert.ok(!isTimeToAsk(state, start + 365 * DAY));
    });

    it('asks after a week and five formats', () => {
        const state = formatTimes(initialState(start), FORMATS_NEEDED);
        assert.ok(isTimeToAsk(state, start + FIRST_WAIT_DAYS * DAY));
    });

    it('never asks again once rated, or once told not to', () => {
        const ready = formatTimes(initialState(start), FORMATS_NEEDED);
        for (const choice of ['rate', 'never'] as const) {
            const after = formatTimes(afterAnswer(ready, choice, start + 8 * DAY), 1000);
            assert.ok(!isTimeToAsk(after, start + 1000 * DAY), choice);
        }
    });

    it('after Later, waits a month and five more formats before asking once more', () => {
        const asked = start + 8 * DAY;
        let state = afterAnswer(formatTimes(initialState(start), FORMATS_NEEDED), 'later', asked);

        assert.ok(!isTimeToAsk(formatTimes(state, FORMATS_NEEDED), asked + (LATER_WAIT_DAYS - 1) * DAY));
        assert.ok(!isTimeToAsk(formatTimes(state, FORMATS_NEEDED - 1), asked + LATER_WAIT_DAYS * DAY));

        state = formatTimes(state, FORMATS_NEEDED);
        assert.ok(isTimeToAsk(state, asked + LATER_WAIT_DAYS * DAY));
    });

    it('treats a notification closed unanswered like Later', () => {
        const asked = start + 8 * DAY;
        const state = afterAnswer(formatTimes(initialState(start), FORMATS_NEEDED), undefined, asked);
        assert.deepStrictEqual(state, afterAnswer(formatTimes(initialState(start), FORMATS_NEEDED), 'later', asked));
    });

    it(`asks at most ${MAX_ASKS} times`, () => {
        let state = initialState(start);
        let now = start;
        let asks = 0;
        for (let round = 0; round < 10; round++) {
            state = formatTimes(state, FORMATS_NEEDED);
            now += 100 * DAY;
            if (isTimeToAsk(state, now)) { asks++; state = afterAnswer(state, 'later', now); }
        }
        assert.strictEqual(asks, MAX_ASKS);
    });
});

describe('ratingPage', () => {
    it('sends VS Code users to the Marketplace review section', () => {
        const page = ratingPage('Visual Studio Code', 'ashtonckj', 'classic-asp-language-support');
        assert.strictEqual(page.site, 'the Marketplace');
        assert.ok(page.url.startsWith('https://marketplace.visualstudio.com/items?itemName=ashtonckj.classic-asp-language-support'));
        assert.ok(ratingPage('Visual Studio Code - Insiders', 'a', 'b').url.includes('marketplace.visualstudio.com'));
    });

    it('sends the editors that install from Open VSX there', () => {
        for (const app of ['VSCodium', 'Cursor', 'Windsurf']) {
            const page = ratingPage(app, 'ashtonckj', 'classic-asp-language-support');
            assert.strictEqual(page.url, 'https://open-vsx.org/extension/ashtonckj/classic-asp-language-support/reviews', app);
        }
    });
});
