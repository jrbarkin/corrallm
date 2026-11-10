import { describe, expect, it } from 'vitest';

import {
  REQUIRED_NOTICES,
  assetNames,
  checkAssets,
  credentialLike,
  debVersion,
  isPrerelease,
  isReleaseVersion,
  missingNotices,
  preflight,
  sha256sums,
  zipNameProblems,
  type PreflightFacts,
} from '../../build/release';

const SIGNING = {
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test (TEAM123456)',
  APPLE_API_KEY: '/keys/AuthKey_X.p8',
  APPLE_API_KEY_ID: 'KEYID',
  APPLE_API_ISSUER: 'issuer',
};
const GREEN = [
  'macos-latest',
  'ubuntu-24.04',
  'ubuntu-24.04-arm',
  'e2e macos-latest (1/2)',
  'e2e macos-latest (2/2)',
  'e2e ubuntu-24.04 (1/2)',
  'e2e ubuntu-24.04 (2/2)',
].map((name) => ({ name, status: 'completed', conclusion: 'success' }));
const commit = 'a'.repeat(40);

function facts(change: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    version: '0.1.0',
    commit,
    packageVersion: '0.1.0',
    onMain: true,
    tagExists: false,
    checkRuns: GREEN,
    auditAdvisories: 0,
    dockerRuns: true,
    dryRun: false,
    env: { ...SIGNING },
    ...change,
  };
}

describe('versions', () => {
  it.each(['0.1.0', '1.20.3', '0.1.0-beta.1', '2.0.0-beta.12'])('accepts %s', (version) => {
    expect(isReleaseVersion(version)).toBe(true);
  });
  it.each(['v0.1.0', '0.1', '0.1.0-rc.1', '0.1.0-beta', '01.1.0', '0.1.0+x', ''])(
    'refuses %s',
    (version) => {
      expect(isReleaseVersion(version)).toBe(false);
    },
  );
  it('calls only a beta a prerelease', () => {
    expect(isPrerelease('0.1.0-beta.1')).toBe(true);
    expect(isPrerelease('0.1.0')).toBe(false);
  });
});

describe('preflight', () => {
  it('accepts the complete case, with either credential form', () => {
    expect(preflight(facts())).toEqual([]);
    expect(
      preflight(
        facts({
          env: {
            APPLE_SIGNING_IDENTITY: SIGNING.APPLE_SIGNING_IDENTITY,
            APPLE_ID: 'a@b.c',
            APPLE_APP_SPECIFIC_PASSWORD: 'x',
            APPLE_TEAM_ID: 'TEAM123456',
          },
        }),
      ),
    ).toEqual([]);
  });

  it('accepts a beta version that matches package.json', () => {
    expect(preflight(facts({ version: '0.1.0-beta.1', packageVersion: '0.1.0-beta.1' }))).toEqual(
      [],
    );
  });

  it.each([
    ['a commit not on origin/main', { onMain: false }, /not on origin\/main/],
    ['a version other than package.json’s', { packageVersion: '0.2.0' }, /package\.json/],
    ['a version that is not semver', { version: 'v0.1.0', packageVersion: 'v0.1.0' }, /version/],
    ['a commit that is not a full hash', { commit: 'abc1234' }, /commit/],
    ['an existing tag or release', { tagExists: true }, /v0\.1\.0 already exists/],
    ['an audit advisory', { auditAdvisories: 1 }, /advisor/],
    ['Docker not running', { dockerRuns: false }, /Docker/],
    [
      'a check run that failed',
      {
        checkRuns: [
          ...GREEN.slice(1),
          { name: 'macos-latest', status: 'completed', conclusion: 'failure' },
        ],
      },
      /macos-latest/,
    ],
    [
      'a check run still in progress',
      {
        checkRuns: [
          ...GREEN.slice(1),
          { name: 'macos-latest', status: 'in_progress', conclusion: null },
        ],
      },
      /macos-latest/,
    ],
    ['a blocking check run that never ran', { checkRuns: GREEN.slice(1) }, /macos-latest/],
    ['no check runs at all', { checkRuns: [] }, /macos-latest/],
  ] as [string, Partial<PreflightFacts>, RegExp][])('refuses %s', (_name, change, message) => {
    expect(preflight(facts(change)).join('\n')).toMatch(message);
  });

  it.each([
    ['CORRALLM_DISTRIBUTION=commercial', { CORRALLM_DISTRIBUTION: 'commercial' }],
    ['CORRALLM_DISTRIBUTION=hosted', { CORRALLM_DISTRIBUTION: 'hosted' }],
    ['CORRALLM_UNSIGNED set', { CORRALLM_UNSIGNED: '1' }],
    ['CORRALLM_E2E_BUILD set', { CORRALLM_E2E_BUILD: '1' }],
  ])('refuses %s', (_name, extra) => {
    expect(preflight(facts({ env: { ...SIGNING, ...extra } })).join('\n')).toMatch(/CORRALLM_/);
  });

  it('accepts the distribution being unset or local', () => {
    expect(preflight(facts({ env: { ...SIGNING, CORRALLM_DISTRIBUTION: 'local' } }))).toEqual([]);
  });

  it.each([
    ['no identity', { APPLE_SIGNING_IDENTITY: undefined }],
    [
      'an identity but no notarization credentials',
      { APPLE_API_KEY: undefined, APPLE_API_KEY_ID: undefined },
    ],
    ['an API key without its id', { APPLE_API_KEY_ID: undefined }],
    [
      'an Apple ID without its team',
      {
        APPLE_API_KEY: undefined,
        APPLE_API_KEY_ID: undefined,
        APPLE_ID: 'a@b.c',
        APPLE_APP_SPECIFIC_PASSWORD: 'x',
      },
    ],
    ['an identity naming no team', { APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test' }],
    ['an empty identity', { APPLE_SIGNING_IDENTITY: '' }],
  ])('refuses %s', (_name, change) => {
    expect(preflight(facts({ env: { ...SIGNING, ...change } })).join('\n')).toMatch(
      /APPLE_|identity/,
    );
  });

  it('never prints a credential’s value', () => {
    const text = preflight(
      facts({ env: { APPLE_SIGNING_IDENTITY: 'secret-identity', APPLE_API_KEY: '/secret/path' } }),
    ).join('\n');
    expect(text).not.toContain('secret-identity');
    expect(text).not.toContain('/secret/path');
  });

  it('reports every refusal, not only the first', () => {
    const refusals = preflight(facts({ onMain: false, tagExists: true, auditAdvisories: 2 }));
    expect(refusals).toHaveLength(3);
  });

  it('does not check what it has not been told (the audit runs in the clone, later)', () => {
    const rest: Partial<PreflightFacts> = facts();
    Reflect.deleteProperty(rest, 'auditAdvisories');
    expect(preflight(rest as PreflightFacts)).toEqual([]);
  });

  describe('a dry run', () => {
    it('allows a commit off main and an unsigned build, and needs no CI or release facts', () => {
      expect(
        preflight(facts({ dryRun: true, onMain: false, env: {}, checkRuns: [], tagExists: false })),
      ).toEqual([]);
    });

    it.each([
      ['a version other than package.json’s', { packageVersion: '9.9.9' }],
      ['an audit advisory', { auditAdvisories: 3 }],
      ['Docker not running', { dockerRuns: false }],
    ])('still refuses %s', (_name, change) => {
      expect(preflight(facts({ dryRun: true, ...change })).length).toBeGreaterThan(0);
    });

    it('still refuses a build that is not a local distribution, or is unsigned by flag', () => {
      expect(
        preflight(facts({ dryRun: true, env: { CORRALLM_DISTRIBUTION: 'hosted' } })),
      ).not.toEqual([]);
      expect(preflight(facts({ dryRun: true, env: { CORRALLM_UNSIGNED: '1' } }))).not.toEqual([]);
    });
  });
});

describe('assetNames', () => {
  it('lists the zip, dmg, both architectures of the deb and rpm, and the checksums', () => {
    expect(assetNames('0.1.0')).toEqual([
      'SHA256SUMS',
      'corrallm-0.1.0-1.arm64.rpm',
      'corrallm-0.1.0-1.x86_64.rpm',
      'corrallm-0.1.0-arm64.dmg',
      'corrallm-darwin-arm64-0.1.0.zip',
      'corrallm_0.1.0_amd64.deb',
      'corrallm_0.1.0_arm64.deb',
    ]);
  });

  it('names a beta’s packages with the tilde that sorts them first', () => {
    const names = assetNames('0.1.0-beta.1');
    expect(names).toContain('corrallm_0.1.0~beta.1_amd64.deb');
    expect(names).toContain('corrallm-0.1.0~beta.1-1.arm64.rpm');
    expect(names).toContain('corrallm-darwin-arm64-0.1.0-beta.1.zip');
    expect(names).toContain('corrallm-0.1.0-beta.1-arm64.dmg');
  });

  it('converts a version for the deb as the installer does', () => {
    expect(debVersion('0.1.0-beta.1')).toBe('0.1.0~beta.1');
    expect(debVersion('0.1.0')).toBe('0.1.0');
  });
});

describe('checkAssets', () => {
  it('accepts exactly the list', () => {
    expect(checkAssets('0.1.0', assetNames('0.1.0'))).toEqual([]);
  });

  it('refuses a missing asset, naming it', () => {
    const names = assetNames('0.1.0').filter((name) => !name.endsWith('.dmg'));
    expect(checkAssets('0.1.0', names).join('\n')).toContain('corrallm-0.1.0-arm64.dmg');
  });

  it('refuses an extra asset, and any Windows one', () => {
    const problems = checkAssets('0.1.0', [
      ...assetNames('0.1.0'),
      'corrallm-0.1.0 Setup.exe',
      'corrallm-win32-x64-0.1.0.zip',
      'notes.txt',
    ]).join('\n');
    expect(problems).toContain('corrallm-0.1.0 Setup.exe');
    expect(problems).toContain('corrallm-win32-x64-0.1.0.zip');
    expect(problems).toContain('notes.txt');
  });

  it('refuses another version’s assets', () => {
    expect(checkAssets('0.1.0', assetNames('0.2.0')).length).toBeGreaterThan(0);
  });
});

describe('zipNameProblems (update.electronjs.org’s rules)', () => {
  it('accepts the zip the release makes', () => {
    expect(zipNameProblems('corrallm-darwin-arm64-0.1.0.zip')).toEqual([]);
  });

  it.each([
    ['corrallm-arm64-0.1.0.zip', /-darwin/],
    ['corrallm-darwin-0.1.0.zip', /-arm64/],
    ['corrallm-darwin-arm64-0.1.0.tar.gz', /\.zip/],
  ])('refuses %s', (name, message) => {
    expect(zipNameProblems(name).join('\n')).toMatch(message);
  });
});

describe('credentialLike', () => {
  it('names a file that looks like a credential, by its basename in any folder', () => {
    expect(
      credentialLike([
        'corrallm.app/Contents/Resources/NOTICE',
        'corrallm.app/Contents/Resources/.env',
        './usr/lib/corrallm/key.pem',
        'a/AuthKey_ABC.p8',
        'b/cert.p12',
        'b/cert.pfx',
        'b/server.key',
        'b/.env.local',
        'b/dotenv.d.ts',
        'b/keyboard.js',
        'b/monkey.keyed',
      ]),
    ).toEqual([
      'corrallm.app/Contents/Resources/.env',
      './usr/lib/corrallm/key.pem',
      'a/AuthKey_ABC.p8',
      'b/cert.p12',
      'b/cert.pfx',
      'b/server.key',
      'b/.env.local',
    ]);
  });

  it('does not flag the sample file the repository keeps, which holds no value', () => {
    expect(credentialLike(['x/.env.example', 'x/.env.sample'])).toEqual([]);
  });
});

describe('missingNotices', () => {
  const listing = (...files: string[]) => files;
  const all = [
    'corrallm.app/Contents/Resources/NOTICE',
    'corrallm.app/Contents/Resources/LICENSE',
    'corrallm.app/Contents/Resources/THIRD-PARTY-NOTICES.txt',
    'corrallm.app/Contents/Resources/claude-agent-sdk-LICENSE.md',
  ];

  it('finds nothing missing when the four are in the resources', () => {
    expect(missingNotices(listing(...all))).toEqual([]);
  });

  it('names each one that is missing', () => {
    expect(missingNotices(listing(all[0] ?? '', all[1] ?? ''))).toEqual([
      'THIRD-PARTY-NOTICES.txt',
      'claude-agent-sdk-LICENSE.md',
    ]);
  });

  it('does not take Electron’s LICENSE beside the app for corrallm’s', () => {
    expect(
      missingNotices([
        'LICENSE',
        'usr/lib/corrallm/LICENSE',
        ...all.filter((f) => !f.endsWith('/LICENSE')),
      ]),
    ).toEqual(['LICENSE']);
  });

  it('accepts the Linux resources path too', () => {
    expect(
      missingNotices(REQUIRED_NOTICES.map((name) => `./usr/lib/corrallm/resources/${name}`)),
    ).toEqual([]);
  });
});

describe('sha256sums', () => {
  it('writes sha256sum -c format, sorted by name, two spaces between', () => {
    expect(
      sha256sums([
        { name: 'b.zip', sha256: 'bb' },
        { name: 'a.dmg', sha256: 'aa' },
      ]),
    ).toBe('aa  a.dmg\nbb  b.zip\n');
  });
});
