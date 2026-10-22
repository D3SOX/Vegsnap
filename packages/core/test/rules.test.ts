import { describe, expect, test } from 'bun:test';
import rules from '../../../data/rules.json';
import { analyzeText, normalizeTerm } from '../src';
import { ruleForTerm } from '../src/analyze';

const aliasRule = new Map(rules.rules.flatMap(rule => rule.aliases.map(alias => [normalizeTerm(alias), rule] as const)));

describe('rule data', () => {
  test('rules have unique kebab-case ids, a status, en/de explanations and known sources', () => {
    const ids = new Set<string>();
    const sourceIds = new Set(rules.sources.map(source => source.id));
    for (const rule of rules.rules) {
      expect(rule.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(ids.has(rule.id)).toBe(false);
      ids.add(rule.id);
      expect(['plant', 'animal', 'ambiguous']).toContain(rule.status);
      expect(rule.explanation.en.trim()).not.toBe('');
      expect(rule.explanation.de.trim()).not.toBe('');
      expect(rule.aliases.length).toBeGreaterThan(0);
      expect(rule.sourceIds.length).toBeGreaterThan(0);
      expect(rule.sourceIds.filter(id => !sourceIds.has(id))).toEqual([]);
    }
  });
  test('normalized aliases never collide across rules', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const rule of rules.rules) for (const alias of rule.aliases) {
      const key = normalizeTerm(alias);
      expect(key).not.toBe('');
      const owner = seen.get(key);
      if (owner && owner !== rule.id) collisions.push(`${key}: ${owner} / ${rule.id}`);
      seen.set(key, rule.id);
    }
    expect(collisions).toEqual([]);
  });
  test('compound stems are animal aliases and plant exceptions never are', () => {
    for (const stem of rules.extendedMatching.compoundStems) expect(aliasRule.get(normalizeTerm(stem))?.status).toBe('animal');
    for (const exception of rules.extendedMatching.plantExceptions) expect(aliasRule.get(normalizeTerm(exception))?.status ?? 'plant').not.toBe('animal');
    for (const alias of rules.extendedMatching.exactOnlyAliases) expect(aliasRule.get(normalizeTerm(alias))?.status).toBe('animal');
  });
  test('animal qualifiers name an animal origin, their domains list animal rules and free-from heads never name an animal', () => {
    const byId = new Map(rules.rules.map(rule => [rule.id, rule]));
    for (const domain of Object.values(rules.extendedMatching.animalQualifiers)) {
      for (const qualifier of domain.qualifiers) expect(aliasRule.get(normalizeTerm(qualifier))?.status ?? 'animal').toBe('animal');
      for (const id of domain.rules) expect(byId.get(id)?.status).toBe('animal');
    }
    for (const head of rules.extendedMatching.freeFromHeads) expect(aliasRule.get(normalizeTerm(head))?.status ?? 'plant').not.toBe('animal');
  });
  test('with-words and conjunctions are single words that never name an ingredient', () => {
    for (const word of [...rules.extendedMatching.withWords, ...rules.extendedMatching.conjunctions]) {
      expect(word).toMatch(/^\p{L}+$/u);
      expect(aliasRule.has(normalizeTerm(word))).toBe(false);
    }
  });
});

describe('extended animal matching', () => {
  test('a contained animal alias or compound stem yields the exact rule while the term is preserved', () => {
    expect(ruleForTerm('milk powder from alpine milk')?.id).toBe('milk');
    expect(ruleForTerm('alpenmilchpulver')?.id).toBe('milk');
    expect(ruleForTerm('rindsleder')?.id).toBe('leather');
    for (const [term, id] of [['alpenvollmilchschokoladenstückchen', 'milk'], ['skummjölksyoghurtpulver', 'milk'], ['bio-kuhmilchpulver', 'milk'], ['h-milch-anteil', 'milk'], ['äggulepulver', 'egg'], ['hühnereiweiß', 'egg']] as const) expect(ruleForTerm(term)?.id).toBe(id);
    const result = analyzeText({ text: 'Ingredients: sugar, milk powder from alpine milk', category: 'food' });
    expect(result.findings.map(item => [item.term, item.status, item.ruleId])).toEqual([['sugar', 'plant', 'sugar'], ['milk powder from alpine milk', 'animal', 'milk']]);
  });
  test('plant exceptions, negations, substitutes and flavours never match an animal rule', () => {
    for (const term of ['oat milk powder', 'hafermilchkonzentrat', 'kokosmilchpulver', 'cream of tartar', 'erdnussbutter', '-baumwolle', 'honigmelone', 'honey melon', 'butter bean', 'butter lettuce', 'silk tofu', 'milchsäurebakterien',
      "lamb's lettuce", 'oyster mushroom powder', 'milk-free chocolate', 'milchfreie schokolade', 'mjölkfritt margarin', 'non-dairy creamer', 'vegan cheese alternative', 'laktosefrei', 'käsearoma', 'cheese flavour', 'cheddar cheese flavour',
      'smak av honung', 'no added milk', 'free from eggs', 'egg substitute', 'synthetic beeswax', 'helianthus annuus pollen extract', 'ei sisällä maitoa', 'ei lisättyä sokeria', 'kokosnüss ei der ernte', 'ingen mjölk', 'inget smör', 'innehåller inte ägg', 'ej honung',
      'gelatinised wheat starch', 'pre-gelatinized starch', 'gelatinierte stärke', 'gelatineringsmedel', 'zahnfleisch', 'zahnseide', 'pazifisches meersalz', 'spezifisch', 'milchig', 'flachs/leinen', 'zellwolle', 'seidenmatt', 'honigklee', 'kokosnussfleisch', 'butterbur extract', 'sea salt grinder', 'tomatfruktkött', 'inlägg: textil', 'skäggolja', 'silkeslen tofu', 'pregelatinized corn starch', 'pregelatinized', 'fake leather upper', 'fake fur trim',
      'honigbuschblätter', 'honungsbuskte', 'without milk and eggs', 'ohne milch und eier', 'milk and egg free', 'free from milk and soya', 'imitation cheese and herbs', 'käse-zwiebel-geschmack',
      'no milk or eggs', 'ohne zusatz von milch', 'utan tillsatt mjölk', 'no beef gelatine', 'kein tierisches lab', 'milch- und eifrei', 'mjölk- och äggfri', 'milk/egg free', 'gluten- und kuhmilcheiweißfrei', 'modersmjölksersättning',
      'butterhead lettuce', 'buttersalat', 'butterbeans', 'keramisk beläggning', 'gräddes i ugn', 'silken tofu powder', 'wollen', 'milchig', 'speckled beans', 'skött', 'lättskött', 'förgelatinerad stärkelse', 'pumpakött', 'tandkött',
      'tamarinder', 'mjölksyrebakterier', 'mjölkvit', 'handleder', 'fiskbensmönstrad', 'fischgrätmuster', 'geografisch', 'filosofisk', 'konfiskerad', 'affisch', 'liebfraumilch', 'butterflies', 'vegetable gelatine',
      'non-dairy milk', 'non-animal whey protein', 'non-animal collagen', 'animal-free collagen', 'nondairy creamer', 'dairy-free milk chocolate', 'dairy free milk chocolate', 'meat-free meatballs', 'egg-free egg noodles', 'milk-free cheese',
      'tierfreies kollagen', 'nicht-tierische gelatine', 'nicht-tierisches kollagen', 'fleischlose wurst', 'eierfreie nudeln', 'djurfritt kollagen', 'icke-animaliskt kollagen', 'mejerifri ost', 'köttfria köttbullar', 'äggfri majonnäs',
      'milk protein-free oat drink', 'egg protein-free pasta', 'dairy ingredient-free spread', 'milk protein free', 'milk and egg protein-free', 'milcheiweiß-frei', 'milch-eiweiß-frei', 'frei von milchbestandteilen', 'milchbestandteile-frei', 'mjölkproteinfri havredryck', 'fri från mjölkprotein', 'egg ingredients free',
      'huhn-/pouletgeschmack', 'milch-/mjölkaroma', 'käse-/ostarom', 'cheese-/milk flavour', 'milk-/egg-free',
      'beef tomatoes', 'king oysters', 'buttercups', 'oyster mushrooms', 'walnut butter', 'coconut butter', 'chickpea milk', 'soybean curd', 'grapefruit butter', 'lättskött tyg', 'reklamaffisch', 'atrofisk', 'smoking oysters',
      'aroma de carne', 'aroma di carne', 'sans sucre ni viande', 'senza zucchero né carne', 'sin azúcar ni carne', 'natural flavouring e471 milk powder', 'fish-free fish sauce', 'fiskfri fisksås', 'eifreie eiernudeln', 'free from gluten and milk', 'frei von gluten und milch', 'fri från gluten och mjölk']) {
      expect(ruleForTerm(term)?.status ?? 'unknown').not.toBe('animal');
    }
  });
  test('a negation, free-from suffix or modifier only blocks the mention it binds to, "with" starts a new phrase and a conjunction ends a modifier phrase', () => {
    for (const [term, id] of [['free range eggs', 'egg'], ['lactose free milk', 'milk'], ['plant oil with milk', 'milk'], ['milk powder with natural flavouring', 'milk'], ['käseersatz mit eigelb', 'egg'], ['laktosefreie vollmilch', 'milk'],
      ['milk powder and natural flavouring', 'milk'], ['natural flavouring and milk powder', 'milk'], ['milk powder & natural flavouring', 'milk'], ['natürliches aroma und milchpulver', 'milk'], ['arom och mjölkpulver', 'milk'], ['yogurt cultures and milk', 'milk'],
      ['non-gmo whole milk', 'milk'], ['non-fat milk', 'milk'], ['no added sugar milk chocolate', 'dairy'], ['no palm oil whole milk powder', 'milk'], ['utan tillsatt socker mjölkchoklad', 'dairy'], ['milk from free range cows', 'milk'], ['eggs from free-range hens', 'egg'],
      ['pasteurized milk lactose-free', 'dairy'], ['milk chocolate sugar free', 'dairy'], ['milk and cellulose', 'milk'], ['honungsrostade jordnötter', 'honey'], ['lanolin cholesterol', 'lanolin'], ['galactooligosaccharides', 'galactooligosaccharides'],
      ['nonfat milk', 'milk'], ['non-hydrogenated milk fat', 'milk-fat'], ['lactose-free milk', 'milk'], ['laktosfri mjölk', 'milk'], ['vattenfritt mjölkfett', 'milk-fat'], ['gluten-free milk chocolate', 'dairy'], ['non-dairy creamer with milk', 'milk'],
      ['milk powder gluten free', 'milk'], ['milk cellulose-free', 'milk'], ['pasteurised free range egg yolk', 'egg-albumen'], ['plant oil or milk', 'milk'], ['natürliches aroma oder milchpulver', 'milk'], ['arom eller mjölkpulver', 'milk'], ['milk or vegan alternative', 'milk'],
      ['ei und milch', 'milk'], ['ei aus freilandhaltung', 'egg-albumen'], ['ingefära och mjölk', 'milk'], ['ingrediens: mjölk', 'milk'],
      ['natural flavouring / milk powder', 'milk'], ['natural flavouring/milk powder', 'milk'], ['milk powder / natural flavouring', 'milk'], ['natürliches aroma / milchpulver', 'milk'], ['arom / mjölkpulver', 'milk'], ['mjölk-/mælkepulver', 'milk'],
      ['arôme et viande', 'meat'], ['viande et arôme', 'meat'], ['aroma y carne', 'meat'], ['carne y aroma', 'meat'], ['aromi e carne', 'meat'], ['aromi ed estratto di carne', 'meat'], ['arôme ou viande', 'meat'], ['aroma o carne', 'meat'], ['aromi oppure carne', 'meat'],
      ['arôme avec viande', 'meat'], ['aroma con carne', 'meat'], ['carne con aroma', 'meat'], ['sans sucre, viande', 'meat'],
      ['dairy-free egg noodles', 'egg-albumen'], ['egg-free milk chocolate', 'dairy'], ['meat-free milk chocolate', 'dairy'], ['eifreie milchschokolade', 'dairy'], ['fleischfreie eiernudeln', 'egg-albumen'], ['äggfri mjölkchoklad', 'dairy'], ['mejerifri äggpasta', 'egg'],
      ['no added sugar and contains whole milk', 'milk'], ['kein zuckerzusatz und enthält vollmilch', 'milk'], ['utan tillsatt socker och innehåller helmjölk', 'milk'], ['sans sucre ajouté et contient du fromage', 'cheese']] as const) {
      expect(ruleForTerm(term)?.id).toBe(id);
    }
  });
  test('a plant exception only covers a word it starts or follows as a compound component, never an overlapping animal alias', () => {
    for (const [term, id] of [['goat milk powder', 'milk'], ['oat milk and goat milk', 'dairy'], ['goat cream', 'cream'], ['buttermilk thistle', 'milk'], ['rökt griskött', 'meat'], ['malet griskött', 'meat'], ['gemahlene fischgräten', 'fish'], ['fischgräten gemahlen', 'fish']] as const) {
      expect(ruleForTerm(term)?.id).toBe(id);
    }
    for (const term of ['oat milk powder', 'walnut butter', 'kokosnussmilch', 'tomatfruktkött', 'hafermilchkonzentrat', 'lättskött', 'fischgrätmuster', 'tamarinder', 'king oysters']) expect(ruleForTerm(term)?.status ?? 'unknown').not.toBe('animal');
  });
  test('plant and ambiguous rules only match exactly', () => {
    expect(ruleForTerm('natural flavouring with vanilla')).toBeUndefined();
    expect(ruleForTerm('e471 from palm oil')).toBeUndefined();
    expect(ruleForTerm('wheat flour blend')).toBeUndefined();
  });
  test('AI-split terms and local guards share the extended matching without duplicate findings', () => {
    const text = 'Ingredients: sugar, alpine milk powder, kapselhülle: gelatine';
    const result = analyzeText({ text, category: 'food' }, undefined, ['sugar', 'alpine milk powder', 'gelatine']);
    expect(result.outcome).toBe('not_vegan');
    expect(result.findings.map(item => [item.term, item.ruleId])).toEqual([['sugar', 'sugar'], ['alpine milk powder', 'milk'], ['gelatine', 'gelatin']]);
  });
  test('a slash ends a flavour phrase, so the AI guard keeps the milk the split omitted', () => {
    const result = analyzeText({ text: 'Ingredients: sugar, natural flavouring / milk powder', category: 'food' }, undefined, ['sugar']);
    expect(result.outcome).toBe('not_vegan');
    expect(result.findings.map(item => [item.term, item.status])).toEqual([['sugar', 'plant'], ['natural flavouring / milk powder', 'animal']]);
  });
  test('an animal role prefix outranks an ambiguous suffix the AI split kept', () => {
    const result = analyzeText({ text: 'Zutaten: Milchschokolade: E471, Zucker', category: 'food' }, undefined, ['e471', 'zucker']);
    expect(result.outcome).toBe('not_vegan');
    expect(result.findings.map(item => [item.term, item.status])).toEqual([['e471', 'ambiguous'], ['zucker', 'plant'], ['milchschokolade: e471', 'animal']]);
  });
});
