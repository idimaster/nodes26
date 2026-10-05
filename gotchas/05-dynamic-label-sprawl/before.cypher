// Before: the agent may invent labels. Two runs name the same concept twice.
CREATE (r:DataResidency {deal_code: $deal, id: 'eu-ledgers', description: 'EU customer ledgers stay in EU regions.'}) RETURN r.id AS id;
CREATE (r:DataResidencyRequirement {deal_code: $deal, id: 'eu-backups', description: 'Backups of EU ledgers stay in EU regions.'}) RETURN r.id AS id;
// The question "what residency requirements does this deal have?" finds only one of them.
MATCH (r:DataResidencyRequirement {deal_code: $deal}) RETURN collect(r.id) AS ids;
