/** Folder, host and file-name parts that are generic technical vocabulary, never a project or company name. */
export const GENERIC_PARTS = new Set(`
api apis src lib libs app apps www web doc docs test tests spec specs dist build bin pkg packages
modules node_modules vendor components services service utils util helpers hooks models views
controllers routes pages layouts middleware public static assets styles images config configs
scripts core common shared internal cmd main index server client frontend backend database
migrations schema types users home projects repos code dev workspace desktop documents downloads
github gitlab bitbucket wiki blog admin auth login dashboard settings status staging prod
production local localhost master develop feature release issues pull tree blob
com net org edu gov info co io uk
node npm git
etc var usr tmp opt log logs conf env cache caches library applications temp target coverage
fixtures mocks e2e html css sql img fonts media uploads tools repo cdn mail
`.split(/\s+/).filter(Boolean));
