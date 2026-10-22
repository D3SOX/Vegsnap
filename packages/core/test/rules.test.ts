import { describe, expect, test } from 'bun:test';
import rules from '../../../data/rules.json';
import { analyzeText, normalizeTerm } from '../src';
import { compositionTerms, ruleForTerm } from '../src/analyze';

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
      'aroma de carne', 'aroma di carne', 'sans sucre ni viande', 'senza zucchero né carne', 'sin azúcar ni carne', 'natural flavouring e471 milk powder', 'fish-free fish sauce', 'fiskfri fisksås', 'eifreie eiernudeln', 'free from gluten and milk', 'frei von gluten und milch', 'fri från gluten och mjölk', 'mushroom pâté', 'vegetable pâté', 'gemüsepastete', 'polyester duvet', 'duvet cover', '100% polyester tweed', 'cotton tweed', 'acrylic tweed', 'polyester crepe de chine', 'polyester dupioni', 'kombu dashi', 'shiitake dashi']) {
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
      ['no added sugar and contains whole milk', 'milk'], ['kein zuckerzusatz und enthält vollmilch', 'milk'], ['utan tillsatt socker och innehåller helmjölk', 'milk'], ['sans sucre ajouté et contient du fromage', 'cheese'], ['liver pâté', 'meat'], ['leberpastete', 'meat'], ['down duvet', 'down'], ['harris tweed', 'animal-hair-fibres'], ['wool tweed', 'wool'], ['silk dupioni', 'silk'], ['katsuo dashi', 'fish'], ['bonito dashi', 'fish']] as const) {
      expect(ruleForTerm(term)?.id).toBe(id);
    }
  });
  test('a plant exception only covers a word it starts or follows as a compound component, never an overlapping animal alias', () => {
    for (const [term, id] of [['goat milk powder', 'milk'], ['oat milk and goat milk', 'dairy'], ['goat cream', 'cream'], ['buttermilk thistle', 'milk'], ['rökt griskött', 'meat'], ['malet griskött', 'meat'], ['gemahlene fischgräten', 'fish'], ['fischgräten gemahlen', 'fish']] as const) {
      expect(ruleForTerm(term)?.id).toBe(id);
    }
    for (const term of ['oat milk powder', 'walnut butter', 'kokosnussmilch', 'tomatfruktkött', 'hafermilchkonzentrat', 'lättskött', 'fischgrätmuster', 'tamarinder', 'king oysters']) expect(ruleForTerm(term)?.status ?? 'unknown').not.toBe('animal');
  });
  test('French, Spanish, Italian and Dutch animal ingredients match whole words and Dutch compounds', () => {
    for (const [term, id] of [['lait écrémé en poudre', 'milk'], ['poudre de lait entier', 'milk'], ['leche desnatada en polvo', 'milk'], ['latte intero in polvere', 'milk'], ['magere melkpoeder', 'milk'],
      ['melkchocolade', 'milk'], ['roomboter', 'butter'], ["jaune d'œuf", 'egg'], ['huevos camperos', 'egg'], ["tuorlo d'uovo", 'egg'], ['kippenvlees', 'meat'], ['ansjovisextract', 'fish'], ['garnalenpasta', 'shellfish'],
      ['jambon de porc', 'meat'], ['gélatine de bœuf', 'gelatin'], ['miel de fleurs', 'honey'], ['queso curado', 'cheese'], ['formaggio grana', 'cheese'], ['lactosérum', 'whey'], ['caseinato de sodio', 'casein'],
      ["lait entier issu de l'agriculture biologique", 'milk'], ['salmon from aquaculture', 'fish'], ["saumon d'aquaculture", 'fish'], ['lachs aus aquakultur', 'fish'], ['aroma en melkpoeder', 'milk'], ['huile végétale - oeufs entiers', 'egg']] as const) {
      expect(ruleForTerm(term)?.id).toBe(id);
    }
  });
  test('French, Spanish, Italian and Dutch plant drinks, nut butters, negations and flavours never match an animal rule', () => {
    for (const term of ['lait végétal', 'leche vegetal', 'latte vegetale', 'plantaardige melk', 'fromage végétal', 'lait de coco', "lait d'amande", 'leche de soja', 'latte di mandorla', 'kokosmelk', 'havermelk', 'pindakaas', 'notenboter', 'cacaoboter', 'beurre de cacao', 'manteca de cacao', 'burro di cacao',
      'tomate coeur de boeuf', 'melkzuurbacteriën', 'vruchtvlees', 'kokosvlees', 'honingmeloen', 'miel de caña', 'nata de coco', 'carne de soja', 'sans lait', 'sin leche', 'senza latte', 'zonder melk', 'lactosevrij', 'melkvrij',
      'saveur fromage', 'sabor a queso', 'gusto formaggio', 'kaassmaak', 'store at room temperature', 'viscose lining', 'weizenmehl', 'vis en acier']) {
      expect(ruleForTerm(term)?.status ?? 'unknown').not.toBe('animal');
    }
  });
  test('Norwegian, Danish and Finnish animal ingredients match whole words and compounds', () => {
    for (const [term, id] of [['skummetmælkspulver', 'milk'], ['helmelkpulver', 'milk'], ['smørfett', 'milk-fat'], ['kremfløte', 'cream'], ['hytteost', 'cheese'], ['eggeplomme', 'egg'], ['æggeblomme', 'egg'],
      ['svinekjøtt', 'meat'], ['oksekød', 'meat'], ['fiskeolje', 'fish'], ['rasvaton maitojauhe', 'milk'], ['täysmaitojauhe', 'milk'], ['maitoproteiini', 'casein'], ['voi', 'butter'], ['laktoositon voi', 'butter'],
      ['kermajauhe', 'cream'], ['juustojauhe', 'cheese'], ['kananmunankeltuainen', 'egg'], ['naudanliha', 'meat'], ['tonnikala', 'fish'], ['hunaja', 'honey'], ['laktosefri mælk', 'milk']] as const) {
      expect(ruleForTerm(term)?.id).toBe(id);
    }
  });
  test('Norwegian, Danish and Finnish plant butters, drinks, look-alike words, negations and flavours never match an animal rule', () => {
    for (const term of ['kakaosmør', 'peanøttsmør', 'kokosfløte', 'havremælk', 'maitohappo', 'kookosmaito', 'juustokumina', 'munakoiso', 'kalamata', 'kala namak', 'hunajameloni', 'hiilihapotettu vesi',
      'lihavoidut ainesosat', 'ranskalainen', 'laksatiivisia', 'raakalakritsi', 'ei sisällä maitoa', 'uten melk', 'uden mælk', 'mælkefri', 'juustonmakuinen', 'ostesmag', 'sel gris']) {
      expect(ruleForTerm(term)?.status ?? 'unknown').not.toBe('animal');
    }
  });
  test('E numbers read the same spaced, hyphenated or with a roman subgroup, and bare INS numbers only after an additive role', () => {
    for (const [term, id] of [['e-471', 'e471'], ['e 471', 'e471'], ['e500ii', 'sodium-carbonates'], ['e-451i', 'phosphates']] as const) expect(ruleForTerm(term)?.id).toBe(id);
    for (const term of ['471', '120', '4711']) expect(ruleForTerm(term)).toBeUndefined();
    expect(compositionTerms('emulsifier (471), mineral salts (452, 450), food acid: 330, preservative (E 202), energy (kcal) 120')).toEqual(['e471', 'e452', 'e450', 'e330', 'e 202', 'energy', 'kcal', '120']);
  });
  test('a long term of repeated plant exceptions is stripped in near-linear time', () => {
    const term = 'oat milk '.repeat(2_300).slice(0, 20_000).trim();
    const started = performance.now();
    expect(ruleForTerm(term)).toBeUndefined();
    expect(analyzeText({ text: term, category: 'food', complete: true }).outcome).toBe('uncertain');
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(ruleForTerm(`${term} goat milk`)?.id).toBe('dairy');
  });
  test('repeated negations resolve in near-linear time and keep covering each mention', () => {
    const term = 'no milk '.repeat(2_500).slice(0, 20_000).trim();
    const started = performance.now();
    expect(ruleForTerm(term)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(ruleForTerm(`${term} with milk`)?.id).toBe('milk');
  });
  test('German egg counts with an adjective or preposition, Finnish and Romanian ei and Milchling mushrooms do not', () => {
    for (const term of ['frisches ei', 'getrocknetes ei', 'flüssiges ei', 'ganzes ei', 'rohes ei', 'nudeln mit frischem ei', 'mit flüssigem ei', 'ei von freilaufenden hühnern', 'ei aus bio-haltung']) expect(ruleForTerm(term)?.id).toBe('egg');
    for (const term of ['ohne frisches ei', 'tuote ei sisällä maitoa', 'ei sisällä maitoa / ohne frisches ei', 'suntem ei', 'putem ei', 'ales ei', 'mies ei', 'puuaines ei sisällä maitoa', 'milchling', 'pfeffer-milchlinge', 'milchbrätling', 'edel-reizker']) expect(ruleForTerm(term)?.status ?? 'unknown').not.toBe('animal');
  });
  test('unsourced calcium carbonate, activated charcoal and dashi are ambiguous while their mineral, plant and fish forms keep their status', () => {
    for (const term of ['calcium carbonate', 'calciumcarbonat', 'ci 77220', 'activated charcoal', 'activated carbon', 'aktivkohle', 'charcoal', 'dashi']) expect(ruleForTerm(term)?.status).toBe('ambiguous');
    for (const term of ['e170', 'chalk', 'limestone', 'calcite', 'precipitated calcium carbonate', 'calcium carbonate from algae', 'vegetable carbon', 'e153', 'coconut charcoal', 'bamboo charcoal', 'holzkohle']) expect(ruleForTerm(term)?.status).toBe('plant');
    for (const term of ['bone char', 'bone charcoal', 'oyster shell powder', 'katsuo dashi']) expect(ruleForTerm(term)?.status).toBe('animal');
  });
  test('unsourced hydroxyapatite, chitosan, natural and coral calcium are ambiguous while synthetic and bone-derived hydroxyapatite keep their status', () => {
    for (const term of ['hydroxyapatite', 'hydroxylapatit', 'calcium hydroxyapatite', 'nano-hydroxyapatite', 'chitosan', 'chitin', 'natural calcium', 'coral calcium']) expect(ruleForTerm(term)?.status).toBe('ambiguous');
    for (const term of ['synthetic hydroxyapatite', 'synthetisches hydroxylapatit', 'tricalcium phosphate', 'e341', 'calcium citrate', 'e333']) expect(ruleForTerm(term)?.status).toBe('plant');
    for (const term of ['microcrystalline hydroxyapatite', 'bovine hydroxyapatite', 'hydroxyapatite from bone', 'bone phosphate', 'e542', 'nacre', 'pearl powder', 'calcium citrate from oyster shells']) expect(ruleForTerm(term)?.status).toBe('animal');
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
