const SOFT_DRIFT = 0.035;
const STARTUP_HOLD = 0.08;
const RUNNING_HOLD = 0.16;

/** Hold leaders until the slowest decoder catches up; never seek past frames. */
export function synchronizationPlan(times: number[], held: boolean[], settling: boolean) {
  const time = Math.min(...times);
  const spread = Math.max(...times) - time;
  return {
    time, spread,
    hold: times.map((value, index) => !held[index] && value - time > (settling ? STARTUP_HOLD : RUNNING_HOLD)),
    resume: times.map((value, index) => held[index] && value - time <= SOFT_DRIFT),
    rates: times.map((value) => value - time <= SOFT_DRIFT ? 1 : Math.round(Math.max(0.96, 1 - (value - time) * 0.5) * 1000) / 1000),
    aligned: spread <= STARTUP_HOLD,
  };
}
