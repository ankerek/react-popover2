import { createElement, createClass, DOM as E, PropTypes as T } from 'react'
import { findDOMNode } from 'react-dom'
import throttle from 'lodash.throttle'
import * as cssVendor from 'css-vendor'
import resizeEvent from './on-resize'
import Layout from './layout'
import ReactLayerMixin from './react-layer-mixin'
import { isServer, window } from './platform'
import { arrayify, clientOnly } from './utils'
import Tip from './tip'

const be = (moduleName, elementName, modifiers = []) => {
  let className = elementName ? `${moduleName}-${elementName}` : `${moduleName}`;

  if (modifiers.length) {
    className = modifiers.filter(x => x).reduce((acc, modifier) => `${acc} ${className}--${modifier}`, className);
  }

  return className;
}

const toArray = value => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    return value.split(' ');
  }

  return value;
}

const supportedCSSValue = clientOnly(cssVendor.supportedValue)

const jsprefix = (x) => (
  `${cssVendor.prefix.js}${x}`
)

const cssprefix = (x) => (
  `${cssVendor.prefix.css}${x}`
)

const cssvalue = (prop, value) => (
  supportedCSSValue(prop, value) || cssprefix(value)
)

const coreStyle = {
  position: `absolute`,
  top: 0,
  left: 0,
  display: cssvalue(`display`, `flex`),
}

const faces = {
  above: `down`,
  right: `left`,
  below: `up`,
  left: `right`,
}

/* Flow mappings. Each map maps the flow domain to another domain. */

const flowToTipTranslations = {
  row: `translateY`,
  column: `translateX`,
}

const flowToPopoverTranslations = {
  row: `translateX`,
  column: `translateY`,
}

const Popover = createClass({
  displayName: `popover`,
  propTypes: {
    body: T.node.isRequired,
    children: T.element.isRequired,
    preferPlace: T.oneOf(Layout.validTypeValues),
    place: T.oneOf(Layout.validTypeValues),
    tipSize: T.number,
    offset: T.number,
    refreshIntervalMs: T.oneOfType([ T.number, T.bool ]),
    isOpen: T.bool,
    onOuterAction: T.func,
    enterExitTransitionDurationMs: T.number,
    className: T.string,
    style: T.object,
    parent: T.instanceOf(Element),
  },
  mixins: [ReactLayerMixin()],
  getDefaultProps () {
    return {
      tipSize: 7,
      preferPlace: null,
      place: null,
      offset: 4,
      isOpen: false,
      onOuterAction: function noOperation () {},
      enterExitTransitionDurationMs: 500,
      children: null,
      refreshIntervalMs: 200,
    }
  },
  getInitialState () {
    return {
      standing: `below`,
      exited: !this.props.isOpen, // for animation-dependent rendering, should popover close/open?
      exiting: false, // for tracking in-progress animations
      toggle: this.props.isOpen || false, // for business logic tracking, should popover close/open?
    }
  },
  componentDidMount () {
    this.targetEl = findDOMNode(this)
    if (this.props.isOpen) this.enter()
  },
  componentWillReceiveProps (propsNext) {
    const willOpen = !this.props.isOpen && propsNext.isOpen
    const willClose = this.props.isOpen && !propsNext.isOpen

    if (willOpen) this.open()
    else if (willClose) this.close()

  },
  componentDidUpdate (propsPrev, statePrev) {
    const didOpen = !statePrev.toggle && this.state.toggle
    const didClose = statePrev.toggle && !this.state.toggle

    if (didOpen) this.enter()
    else if (didClose) this.exit()
  },
  componentWillUnmount () {
    /* If the Popover was never opened then then tracking
     initialization never took place and so calling untrack
     would be an error. Also see issue 55. */
    if (this.hasTracked) this.untrackPopover()
  },
  resolvePopoverLayout () {

    /* Find the optimal zone to position self. Measure the size of each zone and use the one with
     the greatest area. */

    const pickerSettings = {
      preferPlace: this.props.preferPlace,
      place: this.props.place,
    }

    /* This is a kludge that solves a general problem very specifically for Popover.
     The problem is subtle. When Popover positioning changes such that it resolves at
     a different orientation, its Size will change because the Tip will toggle between
     extending Height or Width. The general problem of course is that calculating
     zone positioning based on current size is non-trivial if the Size can change once
     resolved to a different zone. Infinite recursion can be triggered as we noted here:
     https://github.com/littlebits/react-popover/issues/18. As an example of how this
     could happen in another way: Imagine the user changes the CSS styling of the popover
     based on whether it was `row` or `column` flow. TODO: Find a solution to generally
     solve this problem so that the user is free to change the Popover styles in any
     way at any time for any arbitrary trigger. There may be value in investigating the
     http://overconstrained.io community for its general layout system via the
     constraint-solver Cassowary. */
    if (this.zone) this.size[this.zone.flow === `row` ? `h` : `w`] += this.props.tipSize
    const zone = Layout.pickZone(pickerSettings, this.frameBounds, this.targetBounds, this.size)
    if (this.zone) this.size[this.zone.flow === `row` ? `h` : `w`] -= this.props.tipSize

    const tb = this.targetBounds
    this.zone = zone

    this.setState({
      standing: zone.standing,
    })

    const axis = Layout.axes[zone.flow]

    const dockingEdgeBufferLength = Math.round(getComputedStyle(this.bodyEl).borderRadius.slice(0, -2)) || 0
    const scrollSize = Layout.El.calcScrollSize(this.frameEl)
    scrollSize.main = scrollSize[axis.main.size]
    scrollSize.cross = scrollSize[axis.cross.size]

    /* When positioning self on the cross-axis do not exceed frame bounds. The strategy to achieve
     this is thus: First position cross-axis self to the cross-axis-center of the the target. Then,
     offset self by the amount that self is past the boundaries of frame. */
    const pos = Layout.calcRelPos(zone, tb, this.size)

    /* Offset allows users to control the distance betweent the tip and the target. */
    pos[axis.main.start] += this.props.offset * zone.order




    /* Constrain containerEl Position within frameEl. Try not to penetrate a visually-pleasing buffer from
     frameEl. `frameBuffer` length is based on tipSize and its offset. */

    const frameBuffer = this.props.tipSize + this.props.offset
    const hangingBufferLength = (dockingEdgeBufferLength * 2) + (this.props.tipSize * 2) + frameBuffer
    const frameCrossStart = this.frameBounds[axis.cross.start]
    const frameCrossEnd = this.frameBounds[axis.cross.end]
    const frameCrossLength = this.frameBounds[axis.cross.size]
    const frameCrossInnerLength = frameCrossLength - frameBuffer * 2
    const frameCrossInnerStart = frameCrossStart + frameBuffer
    const frameCrossInnerEnd = frameCrossEnd - frameBuffer
    const popoverCrossStart = pos[axis.cross.start]
    const popoverCrossEnd = pos[axis.cross.end]

    /* If the popover dose not fit into frameCrossLength then just position it to the `frameCrossStart`.
     popoverCrossLength` will now be forced to overflow into the `Frame` */
    if (pos.crossLength > frameCrossLength) {
      pos[axis.cross.start] = 0

      /* If the `popoverCrossStart` is forced beyond some threshold of `targetCrossLength` then bound
       it (`popoverCrossStart`). */

    } else if (tb[axis.cross.end] < hangingBufferLength) {
      pos[axis.cross.start] = tb[axis.cross.end] - hangingBufferLength

      /* If the `popoverCrossStart` does not fit within the inner frame (honouring buffers) then
       just center the popover in the remaining `frameCrossLength`. */

    } else if (pos.crossLength > frameCrossInnerLength) {
      pos[axis.cross.start] = (frameCrossLength - pos.crossLength) / 2

    } else if (popoverCrossStart < frameCrossInnerStart) {
      pos[axis.cross.start] = frameCrossInnerStart

    } else if (popoverCrossEnd > frameCrossInnerEnd) {
      pos[axis.cross.start] = pos[axis.cross.start] - (pos[axis.cross.end] - frameCrossInnerEnd)
    }

    /* So far the link position has been calculated relative to the target. To calculate the absolute
     position we need to factor the `Frame``s scroll position */

    pos[axis.cross.start] += scrollSize.cross
    pos[axis.main.start] += scrollSize.main

    /* Apply `flow` and `order` styles. This can impact subsequent measurements of height and width
     of the container. When tip changes orientation position due to changes from/to `row`/`column`
     width`/`height` will be impacted. Our layout monitoring will catch these cases and automatically
     recalculate layout. */
    this.containerEl.style.flexFlow = zone.flow
    this.containerEl.style[jsprefix(`FlexFlow`)] = this.containerEl.style.flexFlow
    this.bodyEl.style.order = zone.order
    this.bodyEl.style[jsprefix(`Order`)] = this.bodyEl.style.order

    /* Apply Absolute Positioning. */

    if (this.props.parent) {
      const parentOffset = this.props.parent.getBoundingClientRect()
      this.bodyEl.style.top = `${pos.y}px`
      this.bodyEl.style.left = `${pos.x}px`
      this.containerEl.style.width = `${parentOffset.width}px`
      this.containerEl.style.marginTop = `${parentOffset.height}px`
      this.containerEl.style.zIndex = 1
    }
    else {
      this.containerEl.style.top = `${pos.y}px`
      this.containerEl.style.left = `${pos.x}px`
    }
  },
  checkTargetReposition () {
    if (this.measureTargetBounds()) this.resolvePopoverLayout()
  },
  measurePopoverSize () {
    this.size = Layout.El.calcSize(this.containerEl)
  },
  measureTargetBounds () {
    const newTargetBounds = Layout.El.calcBounds(this.targetEl)

    if (this.targetBounds && Layout.equalCoords(this.targetBounds, newTargetBounds)) {
      return false
    }

    this.targetBounds = newTargetBounds
    return true
  },
  open () {
    if (this.state.exiting) this.animateExitStop()
    this.setState({ toggle: true, exited: false })
  },
  close () {
    this.setState({ toggle: false })
  },
  enter () {
    if (isServer) return
    this.trackPopover()
    this.animateEnter()
  },
  exit () {
    this.animateExit()
    this.untrackPopover()
  },
  animateExitStop () {
    clearTimeout(this.exitingAnimationTimer1)
    clearTimeout(this.exitingAnimationTimer2)
    this.setState({ exiting: false })
  },
  animateExit () {
    this.setState({ exiting: true })
    this.exitingAnimationTimer2 = setTimeout(() => {
      setTimeout(() => {
        this.containerEl.style.transform = `${flowToPopoverTranslations[this.zone.flow]}(${this.zone.order * 50}px)`
        this.containerEl.style.opacity = `0`
      }, 0)
    }, 0)

    this.exitingAnimationTimer1 = setTimeout(() => {
      this.setState({ exited: true, exiting: false })
    }, this.props.enterExitTransitionDurationMs)
  },
  animateEnter () {
    /* Prepare `entering` style so that we can then animate it toward `entered`. */

    this.containerEl.style.transform = `${flowToPopoverTranslations[this.zone.flow]}(${this.zone.order * 50}px)`
    this.containerEl.style[jsprefix(`Transform`)] = this.containerEl.style.transform
    this.containerEl.style.opacity = `0`

    /* After initial layout apply transition animations. */
    /* Hack: http://stackoverflow.com/questions/3485365/how-can-i-force-webkit-to-redraw-repaint-to-propagate-style-changes */
    this.containerEl.offsetHeight

    this.containerEl.style.transitionProperty = `top, left, opacity, transform`
    this.containerEl.style.transitionDuration = `500ms`
    this.containerEl.style.transitionTimingFunction = `cubic-bezier(0.230, 1.000, 0.320, 1.000)`
    this.containerEl.style.opacity = `1`
    this.containerEl.style.transform = `translateY(0)`
    this.containerEl.style[jsprefix(`Transform`)] = this.containerEl.style.transform
  },
  trackPopover () {
    const { className } = this.props;
    const minScrollRefreshIntervalMs = 200
    const minResizeRefreshIntervalMs = 200

    /* Get references to DOM elements. */

    this.containerEl = findDOMNode(this.layerReactComponent)
    this.bodyEl = this.containerEl.querySelector(`.${be(className, 'body')}`)

    /* Note: frame is hardcoded to window now but we think it will
     be a nice feature in the future to allow other frames to be used
     such as local elements that further constrain the popover`s world. */

    this.frameEl = this.props.parent || window
    this.hasTracked = true

    /* Set a general interval for checking if target position changed. There is no way
     to know this information without polling. */
    if (this.props.refreshIntervalMs) {
      this.checkLayoutInterval = setInterval(this.checkTargetReposition, this.props.refreshIntervalMs)
    }

    /* Watch for boundary changes in all deps, and when one of them changes, recalculate layout.
     This layout monitoring must be bound immediately because a layout recalculation can recursively
     cause a change in boundaries. So if we did a one-time force-layout before watching boundaries
     our final position calculations could be wrong. See comments in resolver function for details
     about which parts can trigger recursive recalculation. */

    this.onFrameScroll = throttle(this.onFrameScroll, minScrollRefreshIntervalMs)
    this.onFrameResize = throttle(this.onFrameResize, minResizeRefreshIntervalMs)
    this.onPopoverResize = throttle(this.onPopoverResize, minResizeRefreshIntervalMs)
    this.onTargetResize = throttle(this.onTargetResize, minResizeRefreshIntervalMs)

    this.frameEl.addEventListener(`scroll`, this.onFrameScroll)
    resizeEvent.on(this.frameEl, this.onFrameResize)
    resizeEvent.on(this.containerEl, this.onPopoverResize)
    resizeEvent.on(this.targetEl, this.onTargetResize)

    /* Track user actions on the page. Anything that occurs _outside_ the Popover boundaries
     should close the Popover. */

    window.addEventListener(`mousedown`, this.checkForOuterAction)
    window.addEventListener(`touchstart`, this.checkForOuterAction)

    /* Kickstart layout at first boot. */

    this.measurePopoverSize()
    this.measureFrameBounds()
    this.measureTargetBounds()
    this.resolvePopoverLayout()
  },
  checkForOuterAction (event) {
    const isOuterAction = (
      !this.containerEl.contains(event.target) &&
      !this.targetEl.contains(event.target)
    )
    if (isOuterAction) this.props.onOuterAction(event)
  },
  untrackPopover () {
    clearInterval(this.checkLayoutInterval)
    this.frameEl.removeEventListener(`scroll`, this.onFrameScroll)
    this.props.parent && (this.bodyEl.style.display = 'none')
    resizeEvent.off(this.frameEl, this.onFrameResize)
    resizeEvent.off(this.containerEl, this.onPopoverResize)
    resizeEvent.off(this.targetEl, this.onTargetResize)
    window.removeEventListener(`mousedown`, this.checkForOuterAction)
    window.removeEventListener(`touchstart`, this.checkForOuterAction)
  },
  onTargetResize () {
    this.measureTargetBounds()
    this.resolvePopoverLayout()
  },
  onPopoverResize () {
    this.measurePopoverSize()
    this.resolvePopoverLayout()
  },
  onFrameScroll () {
    this.measureTargetBounds()
    this.resolvePopoverLayout()
  },
  onFrameResize () {
    this.measureFrameBounds()
    this.resolvePopoverLayout()
  },
  measureFrameBounds () {
    this.frameBounds = Layout.El.calcBounds(this.frameEl)
  },
  renderLayer () {
    if (this.state.exited) return null

    const { className = ``, style = {}, modifiers = ``, isOpen} = this.props;
    const { standing } = this.state;

    const popoverProps = {
      className: be(className, null, [standing, isOpen ? 'isOpen' : null].concat(toArray(modifiers))),
      style: { ...coreStyle, ...style }
    }

    /* If we pass array of nodes to component children React will complain that each
     item should have a key prop. This is not a valid requirement in our case. Users
     should be able to give an array of elements applied as if they were just normal
     children of the body component (note solution is to spread array items as args). */

    const popoverBody = arrayify(this.props.body)

    return (
      E.div(popoverProps,
        E.div({ className: be(className, 'body') }, ...popoverBody),
      )
    )
  },
  render () {
    const { className = ``, style = {}, modifiers = ``, isOpen} = this.props;
    const { standing } = this.state;

    return E.div({ className: be(className, 'trigger', [standing, isOpen ? 'isOpen' : null].concat(toArray(modifiers))) }, this.props.children)
  },
})



// Support for CJS
// http://stackoverflow.com/questions/33505992/babel-6-changes-how-it-exports-default
module.exports = Popover
