import request from 'supertest';
import { hashPassword } from '../src/modules/auth/passwords';
import { auth, type Harness, PASSWORD, startHarness } from './harness';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
beforeEach(() => h.reset());
afterAll(() => h.close());

const cookieOf = (res: request.Response, name: string) =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`))!;
const valueOf = (cookie: string) => cookie.split(';')[0]!;

describe('login', () => {
  it('sets httpOnly cookies and returns the user without secrets', async () => {
    const res = await h.http().post('/api/v1/auth/login').send({ username: 'OWNER', password: PASSWORD }).expect(200);
    expect(res.body.user).toEqual(expect.objectContaining({ username: 'owner', role: 'OWNER', active: true }));
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|scrypt/);
    expect(cookieOf(res, 'vp_access')).toMatch(/HttpOnly/);
    expect(cookieOf(res, 'vp_refresh')).toMatch(/Path=\/api\/v1\/auth.*HttpOnly/);
  });

  it('gives the same answer for a wrong password, an unknown user and a deactivated user', async () => {
    await h.db.user.update({ where: { username: 'manager' }, data: { active: false } });
    for (const body of [{ username: 'owner', password: 'nope-nope' }, { username: 'ghost', password: PASSWORD }, { username: 'manager', password: PASSWORD }]) {
      const res = await h.http().post('/api/v1/auth/login').send(body).expect(401);
      expect(res.body.message).toBe('Invalid username or password');
    }
  });

  it('rejects requests without a token and with a forged token', async () => {
    await h.http().get('/api/v1/customers').expect(401);
    await h.http().get('/api/v1/customers').set(auth('eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.')).expect(401);
  });
});

describe('cookie session', () => {
  it('reads with the cookie, and requires X-Requested-With for cookie writes (CSRF)', async () => {
    const login = await h.http().post('/api/v1/auth/login').send({ username: 'owner', password: PASSWORD }).expect(200);
    const access = valueOf(cookieOf(login, 'vp_access'));
    await h.http().get('/api/v1/auth/me').set('Cookie', access).expect(200);
    await h.http().post('/api/v1/customers').set('Cookie', access).send({ name: 'Walk-in' }).expect(403);
    await h.http().post('/api/v1/customers').set('Cookie', access).set('X-Requested-With', 'fetch').send({ name: 'Walk-in' }).expect(201);
  });

  it('rotates refresh tokens and revokes the family when an old one is replayed', async () => {
    const login = await h.http().post('/api/v1/auth/login').send({ username: 'owner', password: PASSWORD }).expect(200);
    const first = valueOf(cookieOf(login, 'vp_refresh'));
    const rotated = await h.http().post('/api/v1/auth/refresh').set('Cookie', first).set('X-Requested-With', 'fetch').expect(200);
    const second = valueOf(cookieOf(rotated, 'vp_refresh'));
    expect(second).not.toBe(first);

    await h.http().post('/api/v1/auth/refresh').set('Cookie', first).set('X-Requested-With', 'fetch').expect(401); // replay
    await h.http().post('/api/v1/auth/refresh').set('Cookie', second).set('X-Requested-With', 'fetch').expect(401); // family revoked
  });

  it('logout revokes the refresh token', async () => {
    const login = await h.http().post('/api/v1/auth/login').send({ username: 'owner', password: PASSWORD }).expect(200);
    const refresh = valueOf(cookieOf(login, 'vp_refresh'));
    await h.http().post('/api/v1/auth/logout').set('Cookie', refresh).set('X-Requested-With', 'fetch').expect(204);
    await h.http().post('/api/v1/auth/refresh').set('Cookie', refresh).set('X-Requested-With', 'fetch').expect(401);
  });

  it('changing the password signs out other sessions', async () => {
    const login = await h.http().post('/api/v1/auth/login').send({ username: 'manager', password: PASSWORD }).expect(200);
    const refresh = valueOf(cookieOf(login, 'vp_refresh'));
    await h.http().post('/api/v1/auth/change-password').set(auth(login.body.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: 'brand-new-pass' }).expect(204);
    await h.http().post('/api/v1/auth/refresh').set('Cookie', refresh).set('X-Requested-With', 'fetch').expect(401);
    await h.http().post('/api/v1/auth/login').send({ username: 'manager', password: 'brand-new-pass' }).expect(200);
  });
});

describe('role permissions are enforced by the API', () => {
  it('salesperson cannot adjust stock, see what vendors are owed, change settings or list users', async () => {
    const s = auth(await h.token('salesperson'));
    await h.http().post('/api/v1/stock/adjustments').set(s).send({ lotNumber: 'LOT AP', markCode: 'AA', type: 'REDUCE', bags: 1, weightKg: 50, reason: 'rot' }).expect(403);
    const vendors = (await h.http().get('/api/v1/vendors').set(s).expect(200)).body as Record<string, unknown>[];
    expect(vendors.length).toBeGreaterThan(0);
    for (const v of vendors) for (const money of ['totalPurchases', 'payableAmount', 'previousDue', 'newDue', 'advanceAmount', 'openingBalance']) expect(v).not.toHaveProperty(money);
    await h.http().get(`/api/v1/vendors/${vendors[0]!.id}/ledger`).set(s).expect(403);
    await h.http().patch(`/api/v1/vendors/${vendors[0]!.id}`).set(s).send({ phone: '1' }).expect(403);
    await h.http().put('/api/v1/settings/sale-charges').set(s).send({ amaliPerBag: 0, marketFeePerBag: 0, amaliEnabled: false, marketFeeEnabled: false }).expect(403);
    await h.http().get('/api/v1/users').set(s).expect(403);
  });

  it('salesperson cannot set credit terms, and never receives purchase costs', async () => {
    const s = auth(await h.token('salesperson'));
    const customers = await h.http().get('/api/v1/customers').set(s).expect(200);
    await h.http().patch(`/api/v1/customers/${customers.body[0].id}`).set(s).send({ creditLimit: 9_999_999 }).expect(403);
    await h.http().patch(`/api/v1/customers/${customers.body[0].id}`).set(s).send({ phone: '+91 90000 00000' }).expect(200);

    const lots = await h.http().get('/api/v1/lots').set(s).expect(200);
    expect(JSON.stringify(lots.body)).not.toContain('purchaseRate');
    const marks = await h.http().get('/api/v1/settings/marks').set(s).expect(200);
    expect(JSON.stringify(marks.body)).not.toContain('defaultPurchaseRate');
    const o = auth(await h.token('owner'));
    const ownerLots = await h.http().get('/api/v1/lots').set(o).expect(200);
    expect(JSON.stringify(ownerLots.body)).toContain('purchaseRate');
  });

  it('manager can adjust stock but cannot change settings; owner can', async () => {
    const m = auth(await h.token('manager'));
    const o = auth(await h.token('owner'));
    await h.http().post('/api/v1/stock/adjustments').set(m).send({ lotNumber: 'lot ap', markCode: 'aa', type: 'REDUCE', bags: 1, weightKg: 52, reason: 'Rotten bag' }).expect(201);
    await h.http().put('/api/v1/settings/sale-charges').set(m).send({ amaliPerBag: 0, marketFeePerBag: 0, amaliEnabled: false, marketFeeEnabled: false }).expect(403);
    await h.http().put('/api/v1/settings/sale-charges').set(o).send({ amaliPerBag: 25, marketFeePerBag: 10, amaliEnabled: true, marketFeeEnabled: true }).expect(200);
  });

  it('owner manages users; a deactivated user cannot refresh', async () => {
    const o = auth(await h.token('owner'));
    const created = await h.http().post('/api/v1/users').set(o).send({ username: 'cashier2', name: 'Asha', role: 'SALESPERSON', password: 'cashier-pass' }).expect(201);
    const login = await h.http().post('/api/v1/auth/login').send({ username: 'cashier2', password: 'cashier-pass' }).expect(200);
    await h.http().patch(`/api/v1/users/${created.body.id}`).set(o).send({ active: false }).expect(200);
    await h.http().post('/api/v1/auth/refresh').set('Cookie', valueOf(cookieOf(login, 'vp_refresh'))).set('X-Requested-With', 'fetch').expect(401);
    const me = (await h.http().get('/api/v1/auth/me').set(o)).body;
    await h.http().patch(`/api/v1/users/${me.id}`).set(o).send({ active: false }).expect(400);
  });
});

describe('organization isolation', () => {
  it('a user of another organization sees none of this organization\'s records', async () => {
    const o = auth(await h.token('owner'));
    const ownCustomers = (await h.http().get('/api/v1/customers').set(o)).body;
    const org = await h.db.organization.create({ data: { slug: 'other-mandi', shopName: 'Other Mandi' } });
    const user = await h.db.user.create({ data: { username: 'other-owner', name: 'Other', passwordHash: await hashPassword(PASSWORD) } });
    await h.db.membership.create({ data: { userId: user.id, organizationId: org.id, role: 'OWNER' } });
    const other = auth((await h.http().post('/api/v1/auth/login').send({ username: 'other-owner', password: PASSWORD }).expect(200)).body.accessToken);

    expect((await h.http().get('/api/v1/customers').set(other).expect(200)).body).toEqual([]);
    expect((await h.http().get('/api/v1/lots').set(other).expect(200)).body).toEqual([]);
    await h.http().get(`/api/v1/customers/${ownCustomers[0].id}`).set(other).expect(404);
    await h.http().post('/api/v1/payments').set(other).send({ customerId: ownCustomers[0].id, amount: 100, paymentMethod: 'CASH' }).expect(404);
    expect(await h.db.payment.count()).toBe(0);
  });
});

describe('rate limiting', () => {
  it('limits login attempts per client', async () => {
    const limited = await startHarness({ nodeEnv: 'development' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 11; i += 1) codes.push((await limited.http().post('/api/v1/auth/login').send({ username: 'x', password: 'y' })).status);
      expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
      expect(codes[10]).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
