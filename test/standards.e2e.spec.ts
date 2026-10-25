import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { auth, type Harness, startHarness } from './harness';

let h: Harness;
let owner: Record<string, string>;

beforeAll(async () => { h = await startHarness(); });
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  owner = auth(await h.token('owner'));
});

describe('date validation', () => {
  it('rejects impossible calendar dates in query and body', async () => {
    await h.http().get('/api/v1/cash-book?date=2026-02-30').set(owner).expect(400);
    await h.http().get('/api/v1/sales?from=2026-13-01').set(owner).expect(400);
    await h.http().get('/api/v1/stock/movements?to=2026-00-10').set(owner).expect(400);
    const res = await h.http().post('/api/v1/expenses').set(owner).send({ date: '2027-02-29', categoryId: '00000000-0000-4000-8000-000000000000', amount: 10 }).expect(400);
    expect(JSON.stringify(res.body.message)).toContain('valid date');
  });

  it('accepts a real date', async () => {
    await h.http().get('/api/v1/cash-book?date=2026-10-26').set(owner).expect(200);
  });
});

describe('Swagger coverage', () => {
  it('documents every endpoint with a summary, description and the standard error responses', () => {
    const doc = SwaggerModule.createDocument(h.app, new DocumentBuilder().setTitle('t').setVersion('1').build());
    const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.entries(item as Record<string, { summary?: string; description?: string; responses: Record<string, unknown> }>)
        .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map(([method, op]) => ({ id: `${method.toUpperCase()} ${path}`, op })));
    expect(operations.length).toBeGreaterThan(50);
    const undocumented = operations.filter(({ op }) => !op.summary || !op.description || !op.responses['400'] || !op.responses['401'] || !op.responses['500']).map(({ id }) => id);
    expect(undocumented).toEqual([]);
  });
});
