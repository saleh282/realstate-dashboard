'use strict';

class AdminDashboardController {
  constructor(usersService) {
    this.usersService = usersService;
  }
  getMetrics() {
    return this.usersService.getDashboardMetricsForAdmin();
  }
}

Object.assign(exports, { AdminDashboardController });
