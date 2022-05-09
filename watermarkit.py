import argparse
import cv2 as cv
import numpy as np
from typing import Tuple


SCALE_FACTOR_H = 6
SCALE_FACTOR_W = 3


def get_args():
    p = argparse.ArgumentParser(description="Watermark an image with a text")
    p.add_argument("image_path", help="Image to watermark")
    p.add_argument("text", help="Text to watermark with")
    p.add_argument("--des", help="Save image", default="watermarked.jpg")
    return p.parse_args()


def write_text_at_centre(canvas, centre, text, thickness, font_scale, color):
    centre_x, centre_y = centre
    textSize, baseLine = cv.getTextSize(text, cv.FONT_HERSHEY_SIMPLEX, font_scale, thickness)
    baseLine += thickness

    text_origin_x = centre_x - textSize[0] // 2
    text_origin_y = centre_y + textSize[1] // 2

    line_origin_x = text_origin_x
    line_origin_y = text_origin_y + 2 * thickness
    line_end_x = text_origin_x + textSize[0]
    line_end_y = line_origin_y

    cv.line(canvas, (line_origin_x, line_origin_y), (line_end_x, line_end_y), color, thickness)
    cv.putText(canvas, text, (text_origin_x, text_origin_y), cv.FONT_HERSHEY_SIMPLEX, font_scale, color, thickness)
    return canvas


def generate_watermark_gray(
            text, thickness, font_scale) -> Tuple[np.ndarray, np.ndarray]:
    global SCALE_FACTOR_H, SCALE_FACTOR_W
    assert SCALE_FACTOR_H > 1 and SCALE_FACTOR_W > 1
    textSize, _ = cv.getTextSize(text, cv.FONT_HERSHEY_SIMPLEX, font_scale, thickness)
    textSize_w, textSize_h = textSize
    bg_w = textSize_w * SCALE_FACTOR_W
    bg_h = textSize_h * SCALE_FACTOR_H
    background = np.zeros((bg_h, bg_w), dtype=np.uint8)
    background = write_text_at_centre(background, (bg_w//2, bg_h//2), text=text, thickness=thickness, font_scale=font_scale, color=255)
    roi = np.zeros_like(background)
    roi_left = (bg_w - textSize_w) // 2 - 1
    roi_right = (bg_w + textSize_w) // 2 + 1
    roi_top = (bg_h - textSize_h) // 2 - 1
    roi_bottom = (bg_h + textSize_h) // 2 + 1
    roi[roi_top:roi_bottom, roi_left:roi_right] = 255
    return background, roi


def watermarkit_put_text(image, text,
              thickness=1, font_scale=0.5, color=(236, 236, 238)):
    global SCALE_FACTOR_H, SCALE_FACTOR_W

    canvas = image.copy()
    image_h, image_w, _ = image.shape

    textSize, _ = cv.getTextSize(text, cv.FONT_HERSHEY_SIMPLEX, font_scale, thickness)
    textSize_w, textSize_h = textSize

    gridSize_w = textSize_w * SCALE_FACTOR_W
    gridSize_h = textSize_h * SCALE_FACTOR_H

    num_x = image_w // gridSize_w + 1
    num_y = image_h // gridSize_h + 1
    print("grid size:", num_x, num_y)

    for i in range(num_x):
        for j in range(num_y):
            grid_centre_x = int(gridSize_w / 2 + i * gridSize_w)
            grid_centre_y = int(gridSize_h / 2 + j * gridSize_h)
            canvas = write_text_at_centre(canvas, (grid_centre_x, grid_centre_y), text, thickness, font_scale, color)

    return canvas


def watermarkit_seamless_clone(image, text,
                             thickness=1, font_scale=0.5):
    global SCALE_FACTOR_H, SCALE_FACTOR_W

    canvas = image.copy()
    image_h, image_w, _ = image.shape

    textSize, _ = cv.getTextSize(text, cv.FONT_HERSHEY_SIMPLEX, font_scale, thickness)
    textSize_w, textSize_h = textSize

    gridSize_w = textSize_w * SCALE_FACTOR_W
    gridSize_h = textSize_h * SCALE_FACTOR_H

    num_x = image_w // gridSize_w
    num_y = image_h // gridSize_h
    print("grid size:", num_x, num_y)

    watermark_gray, watermark_bool = generate_watermark_gray(text=text, thickness=thickness, font_scale=font_scale)
    watermark_dim3 = np.stack([watermark_gray, watermark_gray, watermark_gray], axis=-1)

    for i in range(num_x):
        for j in range(num_y):
            # print(i, j)
            grid_centre_x = int(gridSize_w / 2 + i * gridSize_w)
            grid_centre_y = int(gridSize_h / 2 + j * gridSize_h)
            canvas = cv.seamlessClone(watermark_dim3, canvas, watermark_bool, (grid_centre_x, grid_centre_y), cv.MIXED_CLONE)

    return canvas


if __name__ == '__main__':
    args = get_args()
    image_path = args.image_path
    text = args.text
    des = args.des

    image = cv.imread(image_path)
    assert image is not None, "Image not found"
    watermarked = watermarkit_seamless_clone(image, text)

    cv.imshow("Watermarked", watermarked)
    cv.waitKey()
    cv.imwrite(des, watermarked)
    print(f"saved to {des}")
