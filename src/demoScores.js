const HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">`

function wrap(title, partName, timeBeats, timeBeatType, divisions, measures, tempo) {
  return `${HEADER}
<score-partwise version="4.0">
  <work><work-title>${title}</work-title></work>
  <part-list><score-part id="P1"><part-name>${partName}</part-name></score-part></part-list>
  <part id="P1">
${measures.map((body, i) => {
  const attrs = i === 0
    ? `      <attributes>
        <divisions>${divisions}</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>${timeBeats}</beats><beat-type>${timeBeatType}</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>\n`
    : ''
  const dir = i === 0 && tempo
    ? `      <direction placement="above">
        <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type>
        <sound tempo="${tempo}"/>
      </direction>\n`
    : ''
  return `    <measure number="${i + 1}">\n${attrs}${dir}${body}    </measure>`
}).join('\n')}
  </part>
</score-partwise>`
}

function n(step, octave, duration, type, alter, dot) {
  let xml = '      <note><pitch>'
  xml += `<step>${step}</step>`
  if (alter) xml += `<alter>${alter}</alter>`
  xml += `<octave>${octave}</octave></pitch>`
  xml += `<duration>${duration}</duration><type>${type}</type>`
  if (dot) xml += '<dot/>'
  if (alter === 1) xml += '<accidental>sharp</accidental>'
  if (alter === -1) xml += '<accidental>flat</accidental>'
  xml += '</note>\n'
  return xml
}

// --- Twinkle Twinkle Little Star ---
// C C G G A A G | F F E E D D C
const twinkleXml = wrap('Twinkle Twinkle Little Star', 'Piano', 4, 4, 1, [
  n('C',4,1,'quarter') + n('C',4,1,'quarter') + n('G',4,1,'quarter') + n('G',4,1,'quarter'),
  n('A',4,1,'quarter') + n('A',4,1,'quarter') + n('G',4,2,'half'),
  n('F',4,1,'quarter') + n('F',4,1,'quarter') + n('E',4,1,'quarter') + n('E',4,1,'quarter'),
  n('D',4,1,'quarter') + n('D',4,1,'quarter') + n('C',4,2,'half'),
  n('G',4,1,'quarter') + n('G',4,1,'quarter') + n('F',4,1,'quarter') + n('F',4,1,'quarter'),
  n('E',4,1,'quarter') + n('E',4,1,'quarter') + n('D',4,2,'half'),
  n('G',4,1,'quarter') + n('G',4,1,'quarter') + n('F',4,1,'quarter') + n('F',4,1,'quarter'),
  n('E',4,1,'quarter') + n('E',4,1,'quarter') + n('D',4,2,'half'),
  n('C',4,1,'quarter') + n('C',4,1,'quarter') + n('G',4,1,'quarter') + n('G',4,1,'quarter'),
  n('A',4,1,'quarter') + n('A',4,1,'quarter') + n('G',4,2,'half'),
  n('F',4,1,'quarter') + n('F',4,1,'quarter') + n('E',4,1,'quarter') + n('E',4,1,'quarter'),
  n('D',4,1,'quarter') + n('D',4,1,'quarter') + n('C',4,2,'half'),
], 100)

// --- Ode to Joy ---
// E E F G | G F E D | C C D E | E. D D
// E E F G | G F E D | C C D E | D. C C
const odeXml = wrap('Ode to Joy', 'Piano', 4, 4, 2, [
  n('E',4,2,'quarter') + n('E',4,2,'quarter') + n('F',4,2,'quarter') + n('G',4,2,'quarter'),
  n('G',4,2,'quarter') + n('F',4,2,'quarter') + n('E',4,2,'quarter') + n('D',4,2,'quarter'),
  n('C',4,2,'quarter') + n('C',4,2,'quarter') + n('D',4,2,'quarter') + n('E',4,2,'quarter'),
  n('E',4,3,'quarter',null,true) + n('D',4,1,'eighth') + n('D',4,4,'half'),
  n('E',4,2,'quarter') + n('E',4,2,'quarter') + n('F',4,2,'quarter') + n('G',4,2,'quarter'),
  n('G',4,2,'quarter') + n('F',4,2,'quarter') + n('E',4,2,'quarter') + n('D',4,2,'quarter'),
  n('C',4,2,'quarter') + n('C',4,2,'quarter') + n('D',4,2,'quarter') + n('E',4,2,'quarter'),
  n('D',4,3,'quarter',null,true) + n('C',4,1,'eighth') + n('C',4,4,'half'),
], 120)

// --- Für Elise (opening theme) ---
// E5 D#5 E5 | D#5 E5 B4 | D5 C5 A4 | C4 E4 A4 | B4 E4 G#4 | B4 C5 E5
// D#5 E5 D#5 | E5 B4 D5 | C5 A4
const furEliseXml = wrap('Für Elise (Opening)', 'Piano', 3, 8, 2, [
  n('E',5,1,'eighth') + n('D',5,1,'eighth',1) + n('E',5,1,'eighth'),
  n('D',5,1,'eighth',1) + n('E',5,1,'eighth') + n('B',4,1,'eighth'),
  n('D',5,1,'eighth') + n('C',5,1,'eighth') + n('A',4,1,'eighth'),
  n('C',4,1,'eighth') + n('E',4,1,'eighth') + n('A',4,1,'eighth'),
  n('B',4,1,'eighth') + n('E',4,1,'eighth') + n('G',4,1,'eighth',1),
  n('B',4,1,'eighth') + n('C',5,1,'eighth') + n('E',5,1,'eighth'),
  n('D',5,1,'eighth',1) + n('E',5,1,'eighth') + n('D',5,1,'eighth',1),
  n('E',5,1,'eighth') + n('B',4,1,'eighth') + n('D',5,1,'eighth'),
  n('C',5,1,'eighth') + n('A',4,1,'eighth') + n('A',4,1,'eighth'),
], 72)

export const DEMO_PIECES = [
  {
    id: 'twinkle',
    title: 'Twinkle Twinkle Little Star',
    composer: 'Traditional',
    difficulty: 'Beginner',
    xml: twinkleXml,
  },
  {
    id: 'ode-to-joy',
    title: 'Ode to Joy',
    composer: 'Beethoven',
    difficulty: 'Beginner',
    xml: odeXml,
  },
  {
    id: 'fur-elise',
    title: 'Für Elise',
    composer: 'Beethoven',
    difficulty: 'Intermediate',
    xml: furEliseXml,
  },
]
