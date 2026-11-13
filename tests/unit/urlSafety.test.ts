import { describe, it, expect } from 'vitest';
import { validateExternalHttpUrl } from '../../src/server/services/urlSafety.js';

describe('validateExternalHttpUrl (SEC-5 SSRF & scheme guard)', () => {
  it('accepts valid public http/https portal and webhook URLs', () => {
    expect(validateExternalHttpUrl('https://epms.ppra.gov.pk/public/tenders/active-tenders').valid).toBe(true);
    expect(validateExternalHttpUrl('http://eproc.punjab.gov.pk/ActiveTenders.aspx').valid).toBe(true);
    expect(validateExternalHttpUrl('https://hooks.slack.com/services/T000/B000/XXX').valid).toBe(true);
  });

  it('rejects non-HTTP schemes, embedded credentials, and internal/loopback/metadata IP ranges', () => {
    const blocked = [
      '',
      'not-a-url',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://files.example.gov.pk/tender.pdf',
      'https://user:pass@example.gov.pk/tenders',
      'http://localhost:8080/webhook',
      'http://api.internal/hook',
      'http://intranet/tenders',
      'http://127.0.0.1:3000/api/system/reset',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/internal',
      'http://172.16.4.10/hook',
      'http://192.168.1.1/admin',
      'http://0.0.0.0:3000/',
      'http://[::1]:3000/',
      'http://[::ffff:127.0.0.1]/hook',
      'http://2130706433/',
      'http://0x7f000001/'
    ];

    for (const candidate of blocked) {
      expect(validateExternalHttpUrl(candidate).valid, `expected blocked: ${candidate}`).toBe(false);
    }
  });
});
