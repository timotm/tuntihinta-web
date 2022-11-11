import type { NextPage } from 'next'
import Head from 'next/head'
import styles from '../styles/Home.module.css'
import { Analytics } from '@vercel/analytics/react'
import { Bar } from 'react-chartjs-2'

import { Chart, CategoryScale, LinearScale, BarElement, ChartOptions, ChartData, ParsedDataType, TimeScale } from 'chart.js'
import ChartDataLabels from 'chartjs-plugin-datalabels'
import AnnotationPlugin, { AnnotationOptions } from 'chartjs-plugin-annotation'

import S3 from 'aws-sdk/clients/s3'
import { useEffect, useRef, useState } from 'react'

Chart.register(CategoryScale, LinearScale, BarElement, TimeScale, ChartDataLabels, AnnotationPlugin, TimeScale)

const colorDataPoint = (value: number): string => {
  const colors = [
    { upperLimit: 5.0, color: "#087E8B" },
    { upperLimit: 20.0, color: "#FFE548" },
    { upperLimit: 40.0, color: "#FFB20F" },
    { upperLimit: 60.0, color: "#FF7F27" }
  ]

  const color = colors.find(({ upperLimit }) => value <= upperLimit) || { color: "#FF4B3E" }
  return color.color
}

const leftPad = (value: number, pad: number = 2): string => `${value}`.padStart(pad, "0")

const formatHHMM = (date: Date): string => `${leftPad(date.getHours())}.${leftPad(date.getMinutes())}`
const formatHH = (date: Date): string => `${leftPad(date.getHours())}`

const finnishDate = (date: Date): string => date.toLocaleDateString('sv-SE', { timeZone: "Europe/Helsinki" })
const finnishWeekday = (date: Date): string => date.toLocaleDateString('fi-FI', { weekday: 'long', timeZone: "Europe/Helsinki" })
interface DayPrice {
  date: string,
  hourPrices: {
    startTime: string,
    price: number
  }[]
}

const isFulfilled = <T,>(v: PromiseSettledResult<T>): v is PromiseFulfilledResult<T> => v.status === "fulfilled"

export async function getStaticProps(): Promise<{
  props: {
    data: ChartData<"bar", ParsedDataType<"bar">[]>,
  },
  revalidate: number
}> {
  const s3 = new S3({
    accessKeyId: process.env.TH_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.TH_AWS_SECRET_ACCESS_KEY,
    region: process.env.TH_AWS_REGION,
    apiVersion: '2006-03-01',
  })

  const now = new Date()
  // yesterday (-1) .. tomorrow (+1)
  const dateStrings = [-1, 0, 1]
    .map(i => finnishDate(new Date(now.getTime() + i * 24 * 60 * 60 * 1000)))

  const requests = dateStrings.map(date =>
    s3.getObject({ Bucket: process.env.TH_AWS_BUCKET as string, Key: `${date}.json` }).promise()
  )

  const results: DayPrice[] = (await Promise.allSettled(requests))
    .filter(isFulfilled)
    .slice(-2)
    .map(({ value }) => JSON.parse(value.Body?.toString() ?? '{hourPrices: []}'))

  const dataset = results.flatMap(
    ({ hourPrices }) => hourPrices
      .map(e => ({ x: e.startTime, y: e.price * 1.24, label: (e.price * 1.24).toFixed(0) }))
  )
  const lastStartTime = new Date(Date.parse(dataset.slice(-1)[0].x))
  // new data is released at around 12 UTC
  // So if we don't have tomorrow's data yet, refresh today. Otherwise tomorrow at noonish
  const nextUpdate = new Date(now.getTime())
  nextUpdate.setUTCHours(12, 0, 0, 0)
  if (lastStartTime.getUTCDate() > now.getUTCDate() || lastStartTime.getUTCMonth() > now.getUTCMonth()) {
    nextUpdate.setUTCDate(now.getUTCDate() + 1)
  }

  const dataValidForSeconds = Math.max(Math.floor((nextUpdate.getTime() - now.getTime()) / 1000), 60)


  return {
    props: {
      data: {
        datasets: [{
          backgroundColor: dataset.map(({ y }) => colorDataPoint(y)),
          data: dataset as unknown as ParsedDataType<"bar">[], // TODO: how to use string x?
          datalabels: {
            anchor: 'end',
            align: 'end',
          }
        }]
      },
    },
    revalidate: dataValidForSeconds
  }
}


const findCurrentTimeIndex = (data: { x: string }[]) => {
  const now = new Date()
  const currentTimeIndex = data.findIndex(({ x }) => {
    const startTime = new Date(x)
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000)
    return now >= startTime && now < endTime
  })
  return currentTimeIndex
}

const maxPrice = 100

const annotateCurrentTime = (darkMode: boolean, data: ChartData<"bar", ParsedDataType<"bar">[]>): AnnotationOptions | null => {
  const currentIndex = findCurrentTimeIndex(data.datasets[0].data as unknown as { x: string }[]) // TODO: how to use string x?

  if (currentIndex === -1) {
    return null
  }
  return {
    type: 'box',
    xMin: currentIndex - 0.5,
    xMax: currentIndex + 0.5,
    yMin: 0,
    yMax: maxPrice,
    backgroundColor: darkMode ? 'rgba(255,255,255, 0.3)' : 'rgba(205, 237, 246, 0.45)',
    borderWidth: 0,
  }
}

const annotateDayChanges = (darkMode: boolean, data: ChartData<"bar", ParsedDataType<"bar">[]>): AnnotationOptions[] => {
  interface accumulator {
    lastDate: string,
    indices: number[],
  }

  const foo = data.datasets[0].data.reduce((acc: accumulator, { x }, i) => {
    const date = finnishDate(new Date(x))
    if (acc.lastDate !== date) {
      if (acc.lastDate) {
        acc.indices.push(i)
      }
      acc.lastDate = date
    }
    return acc
  }, { lastDate: '', indices: [] })

  const a1: AnnotationOptions[] = foo.indices.map(i => ({
    type: 'line',
    yMin: 0,
    yMax: maxPrice,
    xMin: i - 0.5,
    xMax: i - 0.5,
    borderColor: darkMode ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
  }))

  if (data.datasets[0].data.length > 0) {
    const a2: AnnotationOptions[] = [0, ...foo.indices].map(i => ({
      type: 'label',
      xValue: i + 1,
      position: 'start',
      yValue: maxPrice - 1,
      content: `${finnishWeekday(new Date(data.datasets[0].data[i].x))}`,
      color: darkMode ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
    })).slice(0, -1) as any // TODO: fix type

    return a1.concat(a2)
  }
  return a1
}

const collectAnnotations = (darkMode: boolean, data: ChartData<"bar", ParsedDataType<"bar">[]>): { [key: string]: AnnotationOptions } => {
  let annotations: { [key: string]: AnnotationOptions } = {}

  const currentTimeAnnotation = annotateCurrentTime(darkMode, data)
  const dayChanges = annotateDayChanges(darkMode, data)

  if (currentTimeAnnotation) {
    annotations['currentTime'] = currentTimeAnnotation
  }

  dayChanges.forEach((a, i) => {
    //  for (const [index, dayChange] of dayChanges.entries()) {
    annotations[`dayChange${i}`] = a
  })

  return annotations
}

const darkModeMediaQuery = (window: Window) => window.matchMedia('(prefers-color-scheme: dark)')

const getCurrentPrice = (data: ChartData<"bar", ParsedDataType<"bar">[]>): string => {
  const currentIndex = findCurrentTimeIndex(data.datasets[0].data as unknown as { x: string }[]) // TODO: how to use string x?
  if (currentIndex === -1) {
    return '-'
  }
  return (data.datasets[0].data[currentIndex].y).toFixed(2)
}

type IntervalFunction = () => void

function useInterval(callback: IntervalFunction, delay: number) {

  const savedCallback = useRef<IntervalFunction | null>(null)

  // Remember the latest callback.
  useEffect(() => {
    savedCallback.current = callback
  })

  // Set up the interval.
  useEffect(() => {
    function tick() {
      if (savedCallback.current !== null) {
        savedCallback.current()
      }
    }
    const id = setInterval(tick, delay)
    return () => clearInterval(id)

  }, [delay])
}

const dateIncludedInData = (data: ChartData<"bar", ParsedDataType<"bar">[]>, date: Date): Boolean => {
  return (data.datasets[0].data as unknown as { x: string }[]).filter(({ x }) => x.slice(0, 10) === date.toISOString().slice(0, 10)).length > 2
}

const Home: NextPage<{ data: ChartData<"bar", ParsedDataType<"bar">[]> }> = ({ data }) => {
  const [time, setTime] = useState(new Date())
  const [darkMode, setDarkMode] = useState(false)
  const [currentPrice, setCurrentPrice] = useState(getCurrentPrice(data))
  useInterval(() => {
    if (time.getHours() >= 14 &&
      time.getHours() < 16) {
      const tomorrow = new Date(time.getTime() + 24 * 60 * 60 * 1000)
      if (!dateIncludedInData(data, tomorrow)) {
        window.location.reload()
      }
    }
  }, 1000 * 60 * 15)

  useEffect(() => {
    const interval = setInterval(() => {
      setTime(new Date())
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    setDarkMode(darkModeMediaQuery(window).matches)
    const handler = (e: MediaQueryListEvent) => setDarkMode(e.matches)
    darkModeMediaQuery(window).addEventListener('change', handler)
    return () => window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    setCurrentPrice(getCurrentPrice(data))
  }, [data, time])

  const annotations = collectAnnotations(darkMode, data)

  const options: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: true,
    plugins: {
      annotation: {
        annotations
      }
    },
    scales: {
      x: {
        ticks: {
          callback: function (value, _index, _ticks) {
            const d = new Date(this.getLabelForValue(value as number))
            return d.getHours() % 2 == 0 ? formatHH(d) : ''
          },
          maxRotation: 0
        },
        grid: {
          color: darkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
        },
      },
      y: {
        type: 'linear',
        min: 0,
        max: maxPrice,
        grid: {
          color: darkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
        },
      },
    }
  }

  const avg = (data.datasets[0].data.reduce((acc, { y }) => acc + y, 0) / data.datasets[0].data.length).toFixed(2)
  const min = (data.datasets[0].data.reduce((acc, { y }) => Math.min(acc, y), 99999.99)).toFixed(2)
  const max = (data.datasets[0].data.reduce((acc, { y }) => Math.max(acc, y), -99999.99)).toFixed(2)

  return (
    <div className={styles.container}>
      <Head>
        <title>Tuntihinnat</title>
        <meta name="description" content="Sähkön tuntihinnat Suomessa" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main className={styles.main}>
        <div className={styles.mainContainer}>
          <div className={styles.timePriceContainer}>
            <div className={styles.time}>{formatHHMM(time)}</div>
            <div className={styles.priceContainer}>
              <div className={styles.price}>{currentPrice}</div>
              <div className={styles.minAvgMaxPrice}>{min} / {avg} / {max}</div>
            </div>
          </div>
          <Bar className={styles.chart} data={data} options={options} />
        </div>
      </main>
      <Analytics />
    </div>
  )
}

export default Home
