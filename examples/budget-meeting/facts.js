'use strict';
// Facts a good summary of the budget-meeting example must contain. A fact passes when every pattern matches.
module.exports = {
  'Deadline is Thursday': [/thursday/i],
  'Deadline moved up (board meeting)': [/board/i, /moved up|earlier|pushed forward|brought forward/i],
  '~12% over last quarter': [/12\s?%|twelve percent/i],
  'Salesforce / CRM licenses': [/salesforce|crm/i],
  'Contractors ~40% over in August': [/40\s?%|forty percent/i],
  'Scope changed (analytics dashboard)': [/scope/i, /dashboard/i],
  'Keep one contractor, drop one': [/(keep|retain)[^.\n]*one|drop[^.\n]*(one|other)|one contractor/i],
  'Spreadsheet due Wednesday': [/spreadsheet/i, /wednesday/i],
  'Ask finance about the deadline': [/finance/i, /deadline|flexib|extension|wiggle/i],
  'Offsite in November': [/offsite|off-site/i, /november/i],
};
