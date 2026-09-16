/**
 * Stands in for ffmpeg in the export job's tests.
 *
 * A real child process, so spawning, pipes, exit codes and killing are all the
 * real thing; only the encoding is fake. It writes the arguments it was given
 * into the output file, which lets a test see exactly what the job asked for,
 * and speaks ffmpeg's -progress format on stdout.
 *
 *   FAKE_ENCODER=ok    write the output, report half then the end, exit 0
 *   FAKE_ENCODER=fail  write nothing, complain on stderr, exit 1
 *   FAKE_ENCODER=hang  write the output, report a little progress, never exit
 */
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const output = args.at(-1)
const mode = process.env.FAKE_ENCODER ?? 'ok'

if (mode === 'fail') {
  process.stderr.write('film.mkv: Invalid data found when processing input\n')
  process.exit(1)
}

writeFileSync(output, JSON.stringify(args))

if (mode === 'hang') {
  process.stdout.write('out_time_us=1000000\nprogress=continue\n')
  setInterval(() => {}, 1000)
} else {
  process.stdout.write('out_time_us=5000000\nprogress=continue\nout_time_us=10000000\nprogress=end\n')
}
