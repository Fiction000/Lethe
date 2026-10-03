import type { JevQualityGate } from './qualityGate';

/**
 * Limited opt-in automation eligibility from the preregistered 12-case
 * synthetic EN/JA smoke evaluation. Not a population-accuracy guarantee.
 * Actual model: jev-1.13.0; corpus SHA256:
 * e1d4dfec8a4e73c0c1ce28446bbcf1b2662edbadb164bb472750c4ae5eee1b61
 * Request aggregate SHA256:
 * 256844e63af32adbc097b2a89dbd1a46bd6ac7275a9a3d816efb1e42a53a0fa9
 * Reading and unseen custom tags remain unqualified. Model changes fail closed.
 */
export const JEV_SMOKE_QUALITY_GATE: JevQualityGate = {
  model: 'jev-1.13.0',
  questionVersion: 'capture-profile-v1',
  qualifiedProfiles: [
    {
      profile: 'book',
      meaning:
        'A substantive capture about a specific book, reading experience, or book review. Incidental mentions, book clubs, or the verb “book” do not qualify.',
    },
    {
      profile: 'movie',
      meaning:
        'A substantive capture about a specific movie, film, or movie review. Incidental mentions do not qualify.',
    },
  ],
  qualifiedTags: [{ tag: 'topic/cinema', description: 'The capture is substantively about a movie or film.' }],
};
