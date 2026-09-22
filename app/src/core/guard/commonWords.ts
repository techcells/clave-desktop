/**
 * Ordinary English words that are often capitalised on screen (sentence starts, headings, buttons,
 * field labels). A capitalised word NOT in this list is treated as a proper noun.
 * Grow this list from the evaluation set's false discards. Never add a name, brand or product.
 */
export const COMMON_WORDS = new Set(`
a about above accept access account action actions active activity add added after again against all also always am an and another answer any anyone app apps are area as ask assigned at attach available away
back backlog bad base based be because been before begin being below best better between big board both bottom branch break bug build built business but button by
call can cancel card case cause change changed changes channel chat check choose clear click close closed code collapse column come comment comments commit common complete completed config confirm connect contact content continue copy cost could count create created current custom customer
daily dashboard data database date day days deadline debug default delete deploy deployed description design details dev did different direct do docs document does doing done down draft due during
each early edit edited either else email empty enable end enter environment error even event every everyone example expand export external
failed false fast feature feedback few field file files filter find first fix fixed focus folder follow for form forward found from full
general get give given go goal going good got great group guide
had has have he header hello help her here hi high him his history home hot how however
i idea if import important in inbox include info inside install internal into is issue issues it item items its
job join just keep key kind know
label last later latest latency launch left less let level like limit line link list live load local log login long look low
made main make manage many mark may me meeting member members menu merge merged message messages might minute minutes mode more most move much must my
name need never new next no none normal not note notes nothing notification notifications now number
of off ok old on once one only open opened option options or order orders other our out over own
page pages panel part pass password path pending people per person phone pick place plan play please point post preview previous primary priority private problem process product production profile progress project public pull push put
question queue quick
ran rate read ready real reason recent record reference refresh regression release remove removed reopen replica reply report reporter request requests required reset resolve resolved response rest result results retry return review reviewer right role root row rows rule run running
same save saved say scan scheduled score screen search second section see select selected send sent server service session set settings share shared she should show side sign simple since site size skip slow small so some someone something sort source space sprint staging start started state status step still stop story subject submit success summary support sure switch sync system
tab table tag take task tasks team template test tests text than thank thanks that the their them then there these they thing this those thread through ticket time title to today together too tool top total track true try turn two type
under until up update updated upload url us use used user users using
value version very via view views
wait want warning was way we week welcome were what when where which while who why will window with without work worked working workspace would write
yes yesterday yet you your
`.split(/\s+/).filter(Boolean));
