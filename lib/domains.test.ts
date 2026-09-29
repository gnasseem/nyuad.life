import { describe, expect, it } from 'vitest';
import { DEFAULT_GROUP_URL, FALCON_MARKET_URL, detectRedirect } from './domains.ts';

describe('detectRedirect', () => {
  it('sends Falcon-dirham trades to Falcon Market', () => {
    for (const question of ['selling 2000 falcons', 'Anyone buying falcons?', 'where can I exchange my falcons for cash', 'need 500 falcon dirhams asap']) {
      expect(detectRedirect(question, {})?.link.url, question).toBe(FALCON_MARKET_URL);
    }
  });
  it('lets the archive answer questions about how falcons work', () => {
    expect(detectRedirect('What are falcons and where can I spend them?', {})).toBeNull();
    expect(detectRedirect('Is the Falcon Team travel agency any good?', {})).toBeNull();
  });
  it('sends listings, rides and lost-and-found to the group', () => {
    const group = 'https://example.com/group';
    const env = { ROR_GROUP_URL: group };
    expect(detectRedirect('Selling a mini fridge, 150 AED', env)?.domain).toBe('listing');
    expect(detectRedirect('anyone going to Dubai tonight? can I get a ride', env)?.domain).toBe('ride');
    expect(detectRedirect('I lost my airpods in the library yesterday', env)?.domain).toBe('lost-found');
    expect(detectRedirect('does anyone have an HDMI cable I can borrow right now', env)?.domain).toBe('live');
    expect(detectRedirect('Selling a mini fridge', env)?.link.url).toBe(group);
    expect(detectRedirect('Selling a mini fridge', {})?.link.url).toBe(DEFAULT_GROUP_URL);
  });
  it('keeps real questions on the site', () => {
    for (const question of ['Which professor is best for calculus?', 'How does summer housing work?', 'Where do students buy cheap furniture?', 'What is the shuttle schedule to Dubai on weekends?', 'How do I get to the airport at night?', 'Where is lost and found on campus?']) {
      expect(detectRedirect(question, {}), question).toBeNull();
    }
  });
});
