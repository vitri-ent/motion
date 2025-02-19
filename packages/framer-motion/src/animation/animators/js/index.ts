import { AnimationPlaybackControls } from "../../types"
import { keyframes as keyframesGeneratorFactory } from "../../generators/keyframes"
import { spring } from "../../generators/spring/index"
import { inertia } from "../../generators/inertia"
import { AnimationState, KeyframeGenerator } from "../../generators/types"
import { DriverControls } from "./types"
import { ValueAnimationOptions } from "../../types"
import { frameloopDriver } from "./driver-frameloop"
import { interpolate } from "../../../utils/interpolate"
import { clamp } from "../../../utils/clamp"
import {
    millisecondsToSeconds,
    secondsToMilliseconds,
} from "../../../utils/time-conversion"
import { calcGeneratorDuration } from "../../generators/utils/calc-duration"

type GeneratorFactory = (
    options: ValueAnimationOptions<any>
) => KeyframeGenerator<any>

const types: { [key: string]: GeneratorFactory } = {
    decay: inertia,
    inertia,
    tween: keyframesGeneratorFactory,
    keyframes: keyframesGeneratorFactory,
    spring,
}

export interface MainThreadAnimationControls<V>
    extends AnimationPlaybackControls {
    sample: (t: number) => AnimationState<V>
}

/**
 * Animate a single value on the main thread.
 *
 * This function is written, where functionality overlaps,
 * to be largely spec-compliant with WAAPI to allow fungibility
 * between the two.
 */
export function animateValue<V = number>({
    autoplay = true,
    delay = 0,
    driver = frameloopDriver,
    keyframes,
    type = "keyframes",
    repeat = 0,
    repeatDelay = 0,
    repeatType = "loop",
    onPlay,
    onStop,
    onComplete,
    onUpdate,
    ...options
}: ValueAnimationOptions<V>): MainThreadAnimationControls<V> {
    let speed = 1

    let hasStopped = false
    let resolveFinishedPromise: VoidFunction
    let currentFinishedPromise: Promise<void>

    /**
     * Resolve the current Promise every time we enter the
     * finished state. This is WAAPI-compatible behaviour.
     */
    const updateFinishedPromise = () => {
        currentFinishedPromise = new Promise((resolve) => {
            resolveFinishedPromise = resolve
        })
    }

    // Create the first finished promise
    updateFinishedPromise()

    let animationDriver: DriverControls | undefined

    const generatorFactory = types[type] || keyframesGeneratorFactory

    /**
     * If this isn't the keyframes generator and we've been provided
     * strings as keyframes, we need to interpolate these.
     * TODO: Support velocity for units and complex value types/
     */
    let mapNumbersToKeyframes: undefined | ((t: number) => V)
    if (
        generatorFactory !== keyframesGeneratorFactory &&
        typeof keyframes[0] !== "number"
    ) {
        mapNumbersToKeyframes = interpolate([0, 100], keyframes, {
            clamp: false,
        })
        keyframes = [0, 100] as any
    }

    const generator = generatorFactory({ ...options, keyframes })

    let mirroredGenerator: KeyframeGenerator<unknown> | undefined
    if (repeatType === "mirror") {
        mirroredGenerator = generatorFactory({
            ...options,
            keyframes: [...keyframes].reverse(),
            velocity: -(options.velocity || 0),
        })
    }

    let playState: AnimationPlayState = "idle"
    let holdTime: number | null = null
    let startTime: number | null = null
    let cancelTime: number | null = null

    /**
     * If duration is undefined and we have repeat options,
     * we need to calculate a duration from the generator.
     *
     * We set it to the generator itself to cache the duration.
     * Any timeline resolver will need to have already precalculated
     * the duration by this step.
     */
    if (generator.calculatedDuration === null && repeat) {
        generator.calculatedDuration = calcGeneratorDuration(generator)
    }

    const { calculatedDuration } = generator

    let resolvedDuration = Infinity
    let totalDuration = Infinity

    if (calculatedDuration !== null) {
        resolvedDuration = calculatedDuration + repeatDelay
        totalDuration = resolvedDuration * (repeat + 1) - repeatDelay
    }

    let currentTime = 0
    const tick = (timestamp: number) => {
        if (startTime === null) return

        /**
         * requestAnimationFrame timestamps can come through as lower than
         * the startTime as set by performance.now(). Here we prevent this,
         * though in the future it could be possible to make setting startTime
         * a pending operation that gets resolved here.
         */
        if (speed > 0) startTime = Math.min(startTime, timestamp)
        if (speed < 0)
            startTime = Math.min(timestamp - totalDuration / speed, startTime)

        if (holdTime !== null) {
            currentTime = holdTime
        } else {
            // Rounding the time because floating point arithmetic is not always accurate, e.g. 3000.367 - 1000.367 =
            // 2000.0000000000002. This is a problem when we are comparing the currentTime with the duration, for
            // example.
            currentTime = Math.round(timestamp - startTime) * speed
        }

        // Rebase on delay
        const timeWithoutDelay = currentTime - delay * (speed >= 0 ? 1 : -1)
        const isInDelayPhase =
            speed >= 0 ? timeWithoutDelay < 0 : timeWithoutDelay > totalDuration
        currentTime = Math.max(timeWithoutDelay, 0)

        /**
         * If this animation has finished, set the current time
         * to the total duration.
         */
        if (playState === "finished" && holdTime === null) {
            currentTime = totalDuration
        }

        let elapsed = currentTime

        let frameGenerator = generator

        if (repeat) {
            /**
             * Get the current progress (0-1) of the animation. If t is >
             * than duration we'll get values like 2.5 (midway through the
             * third iteration)
             */
            const progress = currentTime / resolvedDuration

            /**
             * Get the current iteration (0 indexed). For instance the floor of
             * 2.5 is 2.
             */
            let currentIteration = Math.floor(progress)

            /**
             * Get the current progress of the iteration by taking the remainder
             * so 2.5 is 0.5 through iteration 2
             */
            let iterationProgress = progress % 1.0

            /**
             * If iteration progress is 1 we count that as the end
             * of the previous iteration.
             */
            if (!iterationProgress && progress >= 1) {
                iterationProgress = 1
            }

            iterationProgress === 1 && currentIteration--

            currentIteration = Math.min(currentIteration, repeat + 1)

            /**
             * Reverse progress if we're not running in "normal" direction
             */
            const iterationIsOdd = Boolean(currentIteration % 2)

            if (iterationIsOdd) {
                if (repeatType === "reverse") {
                    iterationProgress = 1 - iterationProgress
                    if (repeatDelay) {
                        iterationProgress -= repeatDelay / resolvedDuration
                    }
                } else if (repeatType === "mirror") {
                    frameGenerator = mirroredGenerator!
                }
            }

            let p = clamp(0, 1, iterationProgress)

            if (currentTime > totalDuration) {
                p = repeatType === "reverse" && iterationIsOdd ? 1 : 0
            }

            elapsed = p * resolvedDuration
        }

        /**
         * If we're in negative time, set state as the initial keyframe.
         * This prevents delay: x, duration: 0 animations from finishing
         * instantly.
         */
        const state = isInDelayPhase
            ? { done: false, value: keyframes[0] }
            : frameGenerator.next(elapsed)

        if (mapNumbersToKeyframes) {
            state.value = mapNumbersToKeyframes(state.value)
        }

        let { done } = state

        if (!isInDelayPhase && calculatedDuration !== null) {
            done = speed >= 0 ? currentTime >= totalDuration : currentTime <= 0
        }

        const isAnimationFinished =
            holdTime === null &&
            (playState === "finished" || (playState === "running" && done))

        if (onUpdate) {
            onUpdate(state.value)
        }

        if (isAnimationFinished) {
            finish()
        }

        return state
    }

    const stopAnimationDriver = () => {
        animationDriver && animationDriver.stop()
        animationDriver = undefined
    }

    const cancel = () => {
        playState = "idle"
        stopAnimationDriver()
        resolveFinishedPromise()
        updateFinishedPromise()
        startTime = cancelTime = null
    }

    const finish = () => {
        playState = "finished"
        onComplete && onComplete()
        stopAnimationDriver()
        resolveFinishedPromise()
    }

    const play = () => {
        if (hasStopped) return

        if (!animationDriver) animationDriver = driver(tick)

        const now = animationDriver.now()

        onPlay && onPlay()

        if (holdTime !== null) {
            startTime = now - holdTime
        } else if (!startTime || playState === "finished") {
            startTime = now
        }

        if (playState === "finished") {
            updateFinishedPromise()
        }

        cancelTime = startTime
        holdTime = null

        /**
         * Set playState to running only after we've used it in
         * the previous logic.
         */
        playState = "running"

        animationDriver.start()
    }

    if (autoplay) {
        play()
    }

    const controls = {
        then(resolve: VoidFunction, reject?: VoidFunction) {
            return currentFinishedPromise.then(resolve, reject)
        },
        get time() {
            return millisecondsToSeconds(currentTime)
        },
        set time(newTime: number) {
            newTime = secondsToMilliseconds(newTime)

            currentTime = newTime
            if (holdTime !== null || !animationDriver || speed === 0) {
                holdTime = newTime
            } else {
                startTime = animationDriver.now() - newTime / speed
            }
        },
        get duration() {
            const duration =
                generator.calculatedDuration === null
                    ? calcGeneratorDuration(generator)
                    : generator.calculatedDuration

            return millisecondsToSeconds(duration)
        },
        get speed() {
            return speed
        },
        set speed(newSpeed: number) {
            if (newSpeed === speed || !animationDriver) return
            speed = newSpeed
            controls.time = millisecondsToSeconds(currentTime)
        },
        get state() {
            return playState
        },
        play,
        pause: () => {
            playState = "paused"
            holdTime = currentTime
        },
        stop: () => {
            hasStopped = true
            if (playState === "idle") return
            playState = "idle"
            onStop && onStop()
            cancel()
        },
        cancel: () => {
            if (cancelTime !== null) tick(cancelTime)
            cancel()
        },
        complete: () => {
            playState = "finished"
            holdTime === null
        },
        sample: (elapsed: number) => {
            startTime = 0
            return tick(elapsed)!
        },
    }

    return controls
}
