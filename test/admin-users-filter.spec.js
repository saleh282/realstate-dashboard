'use strict';

const { AdminUsersController } = require('../src/controllers/admin-users.controller');
const { AccountType } = require('../src/domain/users/identity.types');
describe('Admin users account type filter', () => {
  it('passes the validated accountType filter to the existing paginated user query', async () => {
    const usersService = {
      listForAdmin: jest.fn().mockResolvedValue({ items: [], pagination: { total: 0 } }),
    };
    const controller = new AdminUsersController(usersService, {});
    await controller.list({
      page: 2,
      limit: 20,
      accountType: AccountType.BROKER,
    });
    expect(usersService.listForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        limit: 20,
        accountType: AccountType.BROKER,
      }),
    );
  });
});
